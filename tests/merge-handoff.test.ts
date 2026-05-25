/*
 * Permission to use, copy, modify, and/or distribute this software for
 * any purpose with or without fee is hereby granted.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
 * WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
 * FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
 * DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
 * AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Phase } from "../agent/extensions/bogstandard/db.js";
import {
	INSERT_HANDOFF_PHASE_EVENT_SQL,
	MERGE_QUEUE_NAME,
	MERGE_TASK_NAME,
	SELECT_HANDOFF_RETRY_SQL,
	TRANSITION_TO_MERGING_PENDING_SQL,
	UPSERT_ISSUE_BRANCH_SQL,
	publishWorkerBranchWith,
	refNameForIssue,
	type PublishDeps,
	type QueryRunner,
} from "../agent/extensions/bogstandard/merge-handoff.js";
import {
	ENQUEUE_MERGE_TASK_SQL,
} from "../agent/extensions/bogstandard/merge-queue.js";

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("refNameForIssue", () => {
	it("formats the issue-id under the bogstandard ref namespace", () => {
		expect(refNameForIssue(42)).toBe("refs/bogstandard/issue-42");
		expect(refNameForIssue(1)).toBe("refs/bogstandard/issue-1");
	});
});

describe("queue and task names", () => {
	it("uses the queue created by migration 0006", () => {
		expect(MERGE_QUEUE_NAME).toBe("bogstandard_merge");
	});

	it("uses the task name the merge daemon will register", () => {
		expect(MERGE_TASK_NAME).toBe("merge-issue");
	});
});

describe("UPSERT_ISSUE_BRANCH_SQL", () => {
	it("inserts into issue_branches with the four required columns", () => {
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/INSERT INTO issue_branches/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(
			/\(issue_id,\s*ref_name,\s*head_sha,\s*base_sha\)/,
		);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4\)/);
	});

	it("on conflict updates SHA columns and resets timestamps", () => {
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/ON CONFLICT \(issue_id\) DO UPDATE/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/head_sha\s*=\s*EXCLUDED\.head_sha/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/base_sha\s*=\s*EXCLUDED\.base_sha/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/ref_name\s*=\s*EXCLUDED\.ref_name/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/published_at\s*=\s*now\(\)/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/merged_at\s*=\s*NULL/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/merge_sha\s*=\s*NULL/);
	});

	it("only overwrites a conflicting row while the issue is still in the caller's from phase", () => {
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/issues\.phase\s*=\s*\$5/);
		expect(UPSERT_ISSUE_BRANCH_SQL).toMatch(/issue_branches\.head_sha\s*=\s*EXCLUDED\.head_sha/);
	});
});

// ── publishWorkerBranchWith orchestration ────────────────────────────────────

interface FakeExecCall {
	args: string[];
}

interface ExecResponse {
	stdout?: string;
	stderr?: string;
	code?: number;
	throws?: Error;
}

interface OrderedEvent {
	tag: string;
	detail?: unknown;
}

interface Harness {
	pi: ExtensionAPI;
	execCalls: FakeExecCall[];
	runner: QueryRunner & {
		calls: Array<{ sql: string; params: unknown[] }>;
	};
	events: OrderedEvent[];
}

/**
 * Build a fake pi.exec that returns programmed responses keyed by the
 * first arg (e.g. "rev-parse", "merge-base"). For commands invoked more
 * than once (e.g. "rev-parse HEAD" and "rev-parse --abbrev-ref HEAD"),
 * tests provide multiple entries in order under the same key.
 */
function makeHarness(opts: {
	headSha?: string;
	baseSha?: string;
	currentBranchName?: string | undefined; // undefined = exec throws (detached)
	execOverrides?: Partial<Record<string, ExecResponse[]>>;
	runnerThrows?: Error;
	spawnThrows?: Error;
	transitionRows?: Array<{ current_version_id: string | null }>;
	transitionRowCount?: number;
	retryRow?: {
		phase: Phase;
		current_version_id: string | null;
		ref_name: string | null;
		head_sha: string | null;
		base_sha: string | null;
	};
}): Harness {
	const head = opts.headSha ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
	const base = opts.baseSha ?? "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
	const responses: Record<string, ExecResponse[]> = {
		"rev-parse": [{ stdout: `${head}\n` }],
		"merge-base": [{ stdout: `${base}\n` }],
		"update-ref": [{}],
		branch: [{}],
		...opts.execOverrides,
	};
	if (opts.currentBranchName === undefined && !opts.execOverrides?.["rev-parse"]) {
		// currentBranch() calls `git rev-parse --abbrev-ref HEAD`. By default we
		// program it to throw → currentBranch returns undefined → no branch -D.
		responses["rev-parse"].push({ throws: new Error("detached") });
	} else if (opts.currentBranchName !== undefined && !opts.execOverrides?.["rev-parse"]) {
		responses["rev-parse"].push({ stdout: `${opts.currentBranchName}\n` });
	}

	const consumed: Record<string, number> = {};
	const execCalls: FakeExecCall[] = [];
	const events: OrderedEvent[] = [];

	const pi = {
		exec: async (cmd: string, args: string[]) => {
			expect(cmd).toBe("git");
			execCalls.push({ args });
			events.push({ tag: `git:${args[0]}`, detail: args });
			const key = args[0] ?? "";
			const list = responses[key] ?? [];
			const idx = consumed[key] ?? 0;
			consumed[key] = idx + 1;
			const r = list[idx] ?? {};
			if (r.throws) throw r.throws;
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
		},
	} as unknown as ExtensionAPI;

	const runner: Harness["runner"] = {
		calls: [],
		async query<R extends object>(text: string, params?: unknown[]) {
			runner.calls.push({ sql: text, params: params ?? [] });
			const tag = sqlTag(text);
			events.push({ tag, detail: { sql: text, params } });
			if (opts.runnerThrows && tag === "db:upsert") throw opts.runnerThrows;
			if (opts.spawnThrows && tag === "db:enqueue") throw opts.spawnThrows;
			if (tag === "db:transition") {
				const rows = opts.transitionRows ?? [{ current_version_id: "101" }];
				return {
					rows: rows as unknown as R[],
					rowCount: opts.transitionRowCount ?? rows.length,
				};
			}
			if (tag === "db:retry-select") {
				return {
					rows: opts.retryRow ? [opts.retryRow as unknown as R] : [],
					rowCount: opts.retryRow ? 1 : 0,
				};
			}
			if (tag === "db:enqueue") {
				return {
					rows: [{ id: 1, created: true } as unknown as R],
					rowCount: 1,
				};
			}
			return { rows: [] as R[], rowCount: 0 };
		},
	};

	(pi as unknown as { __deps: PublishDeps }).__deps = {
		runner,
	};

	return { pi, execCalls, runner, events };
}

function depsOf(h: Harness): PublishDeps {
	return (h.pi as unknown as { __deps: PublishDeps }).__deps;
}

function sqlTag(sql: string): string {
	if (sql === "BEGIN") return "db:begin";
	if (sql === "COMMIT") return "db:commit";
	if (sql === "ROLLBACK") return "db:rollback";
	if (sql === UPSERT_ISSUE_BRANCH_SQL) return "db:upsert";
	if (sql === TRANSITION_TO_MERGING_PENDING_SQL) return "db:transition";
	if (sql === INSERT_HANDOFF_PHASE_EVENT_SQL) return "db:phase-event";
	if (sql === SELECT_HANDOFF_RETRY_SQL) return "db:retry-select";
	if (sql === ENQUEUE_MERGE_TASK_SQL) return "db:enqueue";
	return "db:query";
}

describe("publishWorkerBranchWith — happy path", () => {
	it("captures head + base SHA, publishes the ref, upserts, transitions, and spawns", async () => {
		const h = makeHarness({
			headSha: "AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111",
			baseSha: "BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222",
			currentBranchName: "bogstandard/worker-1/issue-7",
		});

		const result = await publishWorkerBranchWith(
			h.pi,
			{ issueId: 7, fromPhase: "implementing", agentId: "worker-1" },
			depsOf(h),
		);

		expect(result).toEqual({
			refName: "refs/bogstandard/issue-7",
			headSha: "AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111",
			baseSha: "BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222",
		});

		// Git invocations in order: rev-parse HEAD, merge-base, update-ref,
		// rev-parse --abbrev-ref HEAD (from currentBranch), detach, branch -D.
		expect(h.execCalls.map((c) => c.args)).toEqual([
			["rev-parse", "HEAD"],
			["merge-base", "HEAD", "main"],
			["update-ref", "refs/bogstandard/issue-7", "AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111"],
			["rev-parse", "--abbrev-ref", "HEAD"],
			["checkout", "--detach", "HEAD"],
			["branch", "-D", "bogstandard/worker-1/issue-7"],
		]);

		expect(h.runner.calls.map((c) => sqlTag(c.sql))).toEqual([
			"db:begin",
			"db:upsert",
			"db:transition",
			"db:phase-event",
			"db:enqueue",
			"db:commit",
		]);
		expect(h.runner.calls[1].params).toEqual([
			7,
			"refs/bogstandard/issue-7",
			"AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111",
			"BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222",
			"implementing",
		]);
		expect(h.runner.calls[2]).toEqual({
			sql: TRANSITION_TO_MERGING_PENDING_SQL,
			params: [7, "implementing"],
		});
		expect(h.runner.calls[3]).toEqual({
			sql: INSERT_HANDOFF_PHASE_EVENT_SQL,
			params: [
				7,
				101,
				"implementing",
				"worker-1",
				JSON.stringify({
					ref_name: "refs/bogstandard/issue-7",
					head_sha: "AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111",
					base_sha: "BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222",
				}),
			],
		});
		expect(h.runner.calls[4]).toEqual({
			sql: ENQUEUE_MERGE_TASK_SQL,
			params: ["merge:7", JSON.stringify({ issueId: 7 })],
		});
		expect(JSON.parse(h.runner.calls[3].params[4] as string)).toEqual({
			ref_name: "refs/bogstandard/issue-7",
			head_sha: "AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111",
			base_sha: "BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222",
		});
	});

	it("publishes the git ref before opening the atomic DB handoff transaction", async () => {
		const h = makeHarness({ currentBranchName: undefined });
		await publishWorkerBranchWith(
			h.pi,
			{ issueId: 3, fromPhase: "green_impl", agentId: "worker-2" },
			depsOf(h),
		);

		const order = h.events
			.map((e) => e.tag)
			.filter((t) =>
				[
					"git:rev-parse",
					"git:merge-base",
					"git:update-ref",
					"db:begin",
					"db:upsert",
					"db:transition",
					"db:phase-event",
					"db:enqueue",
					"db:commit",
				].includes(t),
			);
		// First rev-parse is for HEAD; the second (if any) is for --abbrev-ref HEAD.
		expect(order.slice(0, 9)).toEqual([
			"git:rev-parse",
			"git:merge-base",
			"git:update-ref",
			"db:begin",
			"db:upsert",
			"db:transition",
			"db:phase-event",
			"db:enqueue",
			"db:commit",
		]);
	});

	it("passes the fromPhase through unchanged to the phase update and event", async () => {
		for (const fromPhase of ["implementing", "green_impl"] as Phase[]) {
			const h = makeHarness({ currentBranchName: undefined });
			await publishWorkerBranchWith(
				h.pi,
				{ issueId: 1, fromPhase, agentId: null },
				depsOf(h),
			);
			expect(h.runner.calls.find((c) => c.sql === TRANSITION_TO_MERGING_PENDING_SQL)?.params).toEqual([
				1,
				fromPhase,
			]);
			expect(h.runner.calls.find((c) => c.sql === INSERT_HANDOFF_PHASE_EVENT_SQL)?.params[2]).toBe(fromPhase);
		}
	});

	it("accepts an already-committed matching handoff and reuses the idempotency key", async () => {
		const h = makeHarness({
			currentBranchName: undefined,
			transitionRows: [],
			transitionRowCount: 0,
			retryRow: {
				phase: "merging_pending",
				current_version_id: "101",
				ref_name: "refs/bogstandard/issue-11",
				head_sha: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				base_sha: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			},
		});

		await publishWorkerBranchWith(
			h.pi,
			{ issueId: 11, fromPhase: "implementing", agentId: "worker-1", repairModel: "repair-model" },
			depsOf(h),
		);

		expect(h.runner.calls.map((c) => sqlTag(c.sql))).toEqual([
			"db:begin",
			"db:upsert",
			"db:transition",
			"db:retry-select",
			"db:enqueue",
			"db:commit",
		]);
		expect(h.runner.calls.find((c) => c.sql === INSERT_HANDOFF_PHASE_EVENT_SQL)).toBeUndefined();
		expect(h.runner.calls.find((c) => c.sql === ENQUEUE_MERGE_TASK_SQL)?.params).toEqual([
			"merge:11",
			JSON.stringify({ issueId: 11, repairModel: "repair-model" }),
		]);
	});
});

describe("publishWorkerBranchWith — branch cleanup", () => {
	it("does not delete the branch when currentBranch is detached (returns undefined)", async () => {
		const h = makeHarness({ currentBranchName: undefined });
		await publishWorkerBranchWith(
			h.pi,
			{ issueId: 9, fromPhase: "implementing", agentId: "w" },
			depsOf(h),
		);
		const branchCalls = h.execCalls.filter((c) => c.args[0] === "branch");
		expect(branchCalls).toEqual([]);
	});

	it("does not delete a branch that is not in the bogstandard/ namespace", async () => {
		const h = makeHarness({ currentBranchName: "main" });
		await publishWorkerBranchWith(
			h.pi,
			{ issueId: 9, fromPhase: "implementing", agentId: "w" },
			depsOf(h),
		);
		const branchCalls = h.execCalls.filter((c) => c.args[0] === "branch");
		expect(branchCalls).toEqual([]);
	});

	it("detaches before deleting a bogstandard worker branch", async () => {
		const h = makeHarness({ currentBranchName: "bogstandard/worker-1/issue-9" });
		await publishWorkerBranchWith(
			h.pi,
			{ issueId: 9, fromPhase: "implementing", agentId: "w" },
			depsOf(h),
		);
		const cleanupCalls = h.execCalls.filter(
			(c) => c.args[0] === "checkout" || c.args[0] === "branch",
		);
		expect(cleanupCalls.map((c) => c.args)).toEqual([
			["checkout", "--detach", "HEAD"],
			["branch", "-D", "bogstandard/worker-1/issue-9"],
		]);
	});

	it("returns normally when checkout --detach fails (best-effort cleanup)", async () => {
		const h = makeHarness({
			currentBranchName: "bogstandard/worker-1/issue-9",
			execOverrides: { checkout: [{ code: 1, stderr: "detach failed" }] },
		});
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 9, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).resolves.toEqual(
			expect.objectContaining({ refName: "refs/bogstandard/issue-9" }),
		);
		const branchCalls = h.execCalls.filter((c) => c.args[0] === "branch");
		expect(branchCalls).toEqual([]);
	});

	it("returns normally when branch -D fails (best-effort cleanup)", async () => {
		const h = makeHarness({
			currentBranchName: "bogstandard/worker-1/issue-9",
			execOverrides: { branch: [{ code: 1, stderr: "not deletable" }] },
		});
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 9, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).resolves.toEqual(
			expect.objectContaining({ refName: "refs/bogstandard/issue-9" }),
		);
	});
});

describe("publishWorkerBranchWith — failure modes", () => {
	it("aborts before DB write when `git update-ref` fails", async () => {
		const h = makeHarness({
			execOverrides: { "update-ref": [{ code: 1, stderr: "bad ref" }] },
		});
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 5, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).rejects.toThrow(/bad ref/);
		expect(h.runner.calls).toEqual([]);
	});

	it("rolls back and does not clean up the branch when the DB upsert throws", async () => {
		const h = makeHarness({ runnerThrows: new Error("db down") });
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 5, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).rejects.toThrow(/db down/);
		expect(h.runner.calls.map((c) => sqlTag(c.sql))).toEqual([
			"db:begin",
			"db:upsert",
			"db:rollback",
		]);
		expect(h.execCalls.filter((c) => c.args[0] === "branch")).toEqual([]);
	});

	it("rolls back when enqueue fails", async () => {
		const h = makeHarness({
			currentBranchName: "bogstandard/worker-1/issue-5",
			spawnThrows: new Error("enqueue down"),
		});
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 5, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).rejects.toThrow(/enqueue down/);
		expect(h.runner.calls.map((c) => sqlTag(c.sql))).toEqual([
			"db:begin",
			"db:upsert",
			"db:transition",
			"db:phase-event",
			"db:enqueue",
			"db:rollback",
		]);
		expect(h.execCalls.filter((c) => c.args[0] === "branch")).toEqual([]);
	});

	it("rolls back when the issue is not in the implementation phase and the handoff does not match", async () => {
		const h = makeHarness({
			transitionRows: [],
			transitionRowCount: 0,
			retryRow: {
				phase: "merging_pending",
				current_version_id: "101",
				ref_name: "refs/bogstandard/issue-5",
				head_sha: "DIFFERENT",
				base_sha: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			},
		});
		await expect(
			publishWorkerBranchWith(
				h.pi,
				{ issueId: 5, fromPhase: "implementing", agentId: "w" },
				depsOf(h),
			),
		).rejects.toThrow(/precondition failed/);
		expect(h.runner.calls.map((c) => sqlTag(c.sql))).toEqual([
			"db:begin",
			"db:upsert",
			"db:transition",
			"db:retry-select",
			"db:rollback",
		]);
	});
});
