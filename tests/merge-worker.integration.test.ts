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

/**
 * Integration test: bs-merge-worker startup checks + claim-and-complete loop.
 *
 * Sets up a temp git repo with a real `merge-staging` worktree and a
 * `.bogstandard/config.json` pointing at the temp postgres database. Then:
 *
 *   1. enqueues a merge task via `enqueueMergeTask`,
 *   2. drives the worker in `--once` mode,
 *   3. asserts the row in `merge_tasks` transitions to `state = 'completed'`.
 *
 * The two refusal cases exercise the startup checks (no merge block,
 * no staging worktree) and confirm the actionable error text reaches
 * the operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";

// run-merge-worker.ts imports agent-runner.ts which re-exports
// @earendil-works/pi-agent-core — not installed for npm test.
vi.mock("../scripts/lib/agent-runner.js", () => ({
	runAgentLoopContinue: vi.fn(),
	convertToLlm: vi.fn(),
	createReadTool: vi.fn((cwd: string) => ({ name: "read", cwd })),
	createGrepTool: vi.fn((cwd: string) => ({ name: "grep", cwd })),
	createFindTool: vi.fn((cwd: string) => ({ name: "find", cwd })),
	createLsTool: vi.fn((cwd: string) => ({ name: "ls", cwd })),
	createBashTool: vi.fn((cwd: string) => ({ name: "bash", cwd })),
	createEditTool: vi.fn((cwd: string) => ({ name: "edit", cwd })),
	createWriteTool: vi.fn((cwd: string) => ({ name: "write", cwd })),
	getModel: vi.fn(() => ({})),
	getEnvApiKey: vi.fn(() => undefined),
	Type: {
		Object: (_schema: unknown) => ({}),
		String: (_opts?: unknown) => ({}),
	},
}));
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { getPool } from "../agent/extensions/bogstandard/db.js";
import { enqueueMergeTask } from "../agent/extensions/bogstandard/merge-queue.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { runMergeWorker } from "../scripts/run-merge-worker.js";

const execFileP = promisify(execFile);

const STAGING_RELATIVE = ".bogstandard/merge-staging";

async function git(cwd: string, args: string[]): Promise<void> {
	await execFileP("git", args, { cwd });
}

function writeConfig(
	projectRoot: string,
	dbUrl: string,
	opts: { withMerge: boolean },
): void {
	mkdirSync(resolve(projectRoot, ".bogstandard"), { recursive: true });
	const body: Record<string, unknown> = {
		database_url: dbUrl,
		agent_id: "merge-worker-test",
		stale_lock_timeout_minutes: 60,
	};
	if (opts.withMerge) {
		body.merge = {
			test_command: ["echo", "ok"],
			test_timeout_seconds: 30,
			staging_worktree: STAGING_RELATIVE,
		};
	}
	writeFileSync(
		resolve(projectRoot, ".bogstandard", "config.json"),
		`${JSON.stringify(body, null, 2)}\n`,
	);
}

async function makeProject(opts: {
	dbUrl: string;
	withMerge: boolean;
	withStaging: boolean;
}): Promise<string> {
	const projectRoot = mkdtempSync(join(tmpdir(), "bs-merge-worker-"));
	await git(projectRoot, ["init", "-q"]);
	await git(projectRoot, ["config", "user.email", "test@example.com"]);
	await git(projectRoot, ["config", "user.name", "BogStandard Test"]);
	await git(projectRoot, ["commit", "-q", "--allow-empty", "-m", "init"]);
	if (opts.withStaging) {
		await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE]);
	}
	writeConfig(projectRoot, opts.dbUrl, { withMerge: opts.withMerge });
	return projectRoot;
}

async function fetchTaskState(
	taskId: number,
): Promise<{ state: string; params: { issueId: number } } | undefined> {
	const res = await getPool().query<{
		state: string;
		params: { issueId: number };
	}>(
		`SELECT state, params FROM merge_tasks WHERE id = $1`,
		[taskId],
	);
	return res.rows[0];
}

describe.skipIf(!isPostgresAvailable())("bs-merge-worker integration", () => {
	const handle = useTempDb();
	const cleanupDirs: string[] = [];

	beforeEach(async () => {
		await getPool().query(
			`TRUNCATE merge_task_steps, merge_tasks RESTART IDENTITY CASCADE`,
		);
	});

	afterEach(() => {
		while (cleanupDirs.length > 0) {
			const dir = cleanupDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("claims an enqueued merge task and marks it completed in --once mode", async () => {
		const projectRoot = await makeProject({
			dbUrl: handle.url(),
			withMerge: true,
			withStaging: true,
		});
		cleanupDirs.push(projectRoot);

		const enq = await enqueueMergeTask(getPool(), {
			issueId: 42,
			idempotencyKey: "merge:42",
		});
		expect(enq.created).toBe(true);

		const before = await fetchTaskState(enq.id);
		expect(before?.state).toBe("pending");

		await runMergeWorker({
			projectRoot,
			once: true,
			log: { log: () => {}, warn: () => {}, error: () => {} },
			// Inject a no-op handler so this test only exercises daemon lifecycle,
			// not the full merge logic (which has its own tests in merge-task.test.ts).
			taskHandler: async (_params, _ctx) => {},
		});

		const after = await fetchTaskState(enq.id);
		expect(after?.state).toBe("completed");
		expect(after?.params).toEqual({ issueId: 42 });
	}, 30_000);

	it("refuses to start when merge.test_command is missing", async () => {
		const projectRoot = await makeProject({
			dbUrl: handle.url(),
			withMerge: false,
			withStaging: true,
		});
		cleanupDirs.push(projectRoot);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: { log: () => {}, warn: () => {}, error: () => {} },
			}),
		).rejects.toThrow(/merge.*block.*config\.json/i);
	}, 15_000);

	it("refuses to start when the staging worktree is missing", async () => {
		const projectRoot = await makeProject({
			dbUrl: handle.url(),
			withMerge: true,
			withStaging: false,
		});
		cleanupDirs.push(projectRoot);

		const absStaging = resolve(projectRoot, STAGING_RELATIVE);
		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: { log: () => {}, warn: () => {}, error: () => {} },
			}),
		).rejects.toThrow(`git worktree add --detach ${absStaging} main`);
	}, 15_000);
});
