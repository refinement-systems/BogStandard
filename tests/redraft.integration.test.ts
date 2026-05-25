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
 * Integration tests for `redraftIssue`.
 *
 * redraft is the richest multi-statement transaction in db.ts: it inserts a
 * new version, flips the pointer, attaches a carry-forward comment, and
 * writes a phase_events row — all atomically. These tests pin down the
 * guards, the monotonic version_no derivation, and the UNIQUE constraint
 * that protects two concurrent redrafts of the same issue.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getPool,
	issueCreate,
	issueShowJson,
	recentPhaseEvents,
	redraftIssue,
	transitionPhase,
	type Phase,
} from "../agent/extensions/bogstandard/db.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

async function makePhase(phase: Phase, opts: { needs_tests?: boolean } = {}): Promise<number> {
	// Create at 'drafting' with needs_tests set, then walk to the desired phase via
	// transitionPhase so we have legitimately-formed phase_events history.
	const id = await issueCreate(pi, {
		title: "T",
		priority: "medium",
		needs_tests: opts.needs_tests ?? true,
	});
	if (phase === "drafting") return id;
	await transitionPhase(pi, { issueId: id, from: "drafting", to: "ready", agentId: null });
	if (phase === "ready") return id;
	await transitionPhase(pi, { issueId: id, from: "ready", to: phase, agentId: null });
	return id;
}

describe.skipIf(!isPostgresAvailable())("redraftIssue", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	describe("input validation", () => {
		it("rejects empty title", async () => {
			const id = await makePhase("ready");
			await expect(
				redraftIssue(pi, id, { title: " ", description: "D", needs_tests: false, carry_forward_summary: "x" }, null),
			).rejects.toThrow(/title must not be empty/);
		});

		it("rejects empty carry_forward_summary", async () => {
			const id = await makePhase("ready");
			await expect(
				redraftIssue(pi, id, { title: "T", description: "D", needs_tests: false, carry_forward_summary: "  " }, null),
			).rejects.toThrow(/carry_forward_summary must not be empty/);
		});

		it("throws on missing id", async () => {
			await expect(
				redraftIssue(pi, 9999, { title: "T", description: "D", needs_tests: false, carry_forward_summary: "x" }, null),
			).rejects.toThrow(/Issue 9999 not found/);
		});
	});

	describe("phase preconditions", () => {
		it.each<Phase>(["drafting", "ready", "aborted"])("allowed from %s", async (phase) => {
			const id = await makePhase(phase);
			await expect(
				redraftIssue(pi, id, { title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" }, null),
			).resolves.toMatchObject({ version_no: 2 });
		});

		it.each<Phase>([
			"planning",
			"implementing",
			"red_planning",
			"red_impl",
			"green_planning",
			"green_impl",
			"done",
			"archived",
		])("rejected from %s", async (phase) => {
			const id = await makePhase(phase);
			await expect(
				redraftIssue(pi, id, { title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" }, null),
			).rejects.toThrow(/redraft requires phase to be drafting, ready, or aborted/);
		});
	});

	describe("version_no monotonic", () => {
		it("v1 → redraft to v2 → redraft to v3", async () => {
			const id = await makePhase("ready");
			const r2 = await redraftIssue(
				pi,
				id,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k1" },
				null,
			);
			expect(r2.version_no).toBe(2);
			const r3 = await redraftIssue(
				pi,
				id,
				{ title: "T3", description: "D3", needs_tests: true, carry_forward_summary: "k2" },
				null,
			);
			expect(r3.version_no).toBe(3);

			const detail = await issueShowJson(pi, id, { include_history: true });
			expect(detail.current_version_no).toBe(3);
			expect(detail.history?.map((h) => h.version_no)).toEqual([1, 2, 3]);
		});
	});

	describe("carry-forward comment", () => {
		it("is attached to the new version, not the prior", async () => {
			const id = await makePhase("ready");
			await redraftIssue(
				pi,
				id,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "keep this!" },
				"alice",
			);

			const detail = await issueShowJson(pi, id, { include_history: true });
			const v1 = detail.history?.find((h) => h.version_no === 1);
			const v2 = detail.history?.find((h) => h.version_no === 2);
			expect(v1?.comments.length).toBe(0);
			expect(v2?.comments).toEqual([{ kind: "carry_forward", content: "keep this!" }]);
		});
	});

	describe("phase reset and audit", () => {
		it("phase resets to 'ready' regardless of prior phase", async () => {
			const fromAborted = await makePhase("aborted");
			await redraftIssue(
				pi,
				fromAborted,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" },
				null,
			);
			expect((await issueShowJson(pi, fromAborted)).phase).toBe("ready");

			const fromReady = await makePhase("ready");
			await redraftIssue(
				pi,
				fromReady,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" },
				null,
			);
			expect((await issueShowJson(pi, fromReady)).phase).toBe("ready");
		});

		it("writes a phase_events row with prior phase and version_no metadata", async () => {
			const id = await makePhase("aborted");
			await redraftIssue(
				pi,
				id,
				{ title: "T2", description: "D2", needs_tests: true, carry_forward_summary: "k" },
				"alice",
			);
			const events = await recentPhaseEvents(pi, id, 5);
			expect(events[0]).toMatchObject({
				phase_from: "aborted",
				phase_to: "ready",
				agent_id: "alice",
				reason: "redraft",
			});
			expect(events[0].metadata).toEqual({ version_no: 2 });
		});

		it("records created_by on the new version (defaults to agentId)", async () => {
			const id = await makePhase("ready");
			await redraftIssue(
				pi,
				id,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" },
				"bob",
			);
			const row = await getPool().query<{ created_by: string | null }>(
				`SELECT created_by FROM issue_versions WHERE issue_id = $1 AND version_no = 2`,
				[id],
			);
			expect(row.rows[0].created_by).toBe("bob");
		});

		it("created_by override wins over agentId", async () => {
			const id = await makePhase("ready");
			await redraftIssue(
				pi,
				id,
				{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k", created_by: "carol" },
				"bob",
			);
			const row = await getPool().query<{ created_by: string | null }>(
				`SELECT created_by FROM issue_versions WHERE issue_id = $1 AND version_no = 2`,
				[id],
			);
			expect(row.rows[0].created_by).toBe("carol");
		});
	});

	describe("concurrent redraft", () => {
		it("UNIQUE (issue_id, version_no) rejects the loser; loser's tx rolls back cleanly", async () => {
			// Deterministically reproduce the race: open a manual transaction
			// that inserts version_no=2 but does NOT commit; meanwhile fire
			// redraftIssue() — its MAX query will see only the committed v1
			// (so it computes next=2), its INSERT will block on the unique
			// index, then when we COMMIT the manual tx redraftIssue's INSERT
			// errors with 23505 and the whole tx rolls back cleanly.
			const id = await makePhase("ready");

			const pool = getPool();
			const blocker = await pool.connect();
			try {
				await blocker.query("BEGIN");
				await blocker.query(
					`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests)
					      VALUES ($1, 2, 'manual', 'manual', false)`,
					[id],
				);

				// Fire redraftIssue without awaiting — it should block on the unique index.
				const redraftPromise = redraftIssue(
					pi,
					id,
					{ title: "from redraft", description: "D", needs_tests: false, carry_forward_summary: "k" },
					"alice",
				).catch((e) => e);

				// Give the lock a moment to register, then release it by committing.
				await new Promise((r) => setTimeout(r, 50));
				await blocker.query("COMMIT");

				const outcome = await redraftPromise;
				expect(outcome).toBeInstanceOf(Error);
				expect(String((outcome as Error).message)).toMatch(/duplicate key|issue_versions_issue_id_version_no_key/);
			} finally {
				blocker.release();
			}

			// Loser (redraftIssue) rolled back: there should be exactly v1 + the manual v2.
			const versions = await getPool().query<{ version_no: number; title: string }>(
				`SELECT version_no, title FROM issue_versions WHERE issue_id = $1 ORDER BY version_no`,
				[id],
			);
			expect(versions.rows.map((r) => r.version_no)).toEqual([1, 2]);
			expect(versions.rows[1].title).toBe("manual");

			// No carry_forward comment was written.
			const cfRows = await getPool().query<{ n: string }>(
				`SELECT count(*)::text AS n FROM comments WHERE issue_id = $1 AND kind = 'carry_forward'`,
				[id],
			);
			expect(Number(cfRows.rows[0].n)).toBe(0);

			// No redraft phase_events row.
			const events = await recentPhaseEvents(pi, id, 10);
			expect(events.find((e) => e.reason === "redraft")).toBeUndefined();
		});

		it("two truly parallel redrafts: exactly one wins (constraint backstop)", async () => {
			// Even though node-pg often serializes within a single pool, run
			// many parallel pairs and assert that no run ever produces
			// duplicate version_nos. The UNIQUE constraint guarantees this
			// invariant regardless of whether the race manifests.
			for (let trial = 0; trial < 5; trial++) {
				const id = await makePhase("ready");
				await Promise.allSettled([
					redraftIssue(
						pi,
						id,
						{ title: "A", description: "Da", needs_tests: false, carry_forward_summary: "ka" },
						"alice",
					),
					redraftIssue(
						pi,
						id,
						{ title: "B", description: "Db", needs_tests: false, carry_forward_summary: "kb" },
						"bob",
					),
				]);
				const versions = await getPool().query<{ version_no: number }>(
					`SELECT version_no FROM issue_versions WHERE issue_id = $1 ORDER BY version_no`,
					[id],
				);
				const nos = versions.rows.map((r) => r.version_no);
				// No duplicates, monotonic from 1.
				expect(new Set(nos).size).toBe(nos.length);
				expect(nos[0]).toBe(1);
			}
		});
	});

	describe("atomicity", () => {
		it("a constraint violation in the carry-forward insert rolls back the version + pointer flip", async () => {
			const id = await makePhase("ready");
			const v1Detail = await issueShowJson(pi, id);

			// Force a deliberate failure mid-tx by temporarily adding a CHECK
			// constraint on comments.content that rejects any carry_forward.
			await getPool().query(
				`ALTER TABLE comments ADD CONSTRAINT comments_no_cf CHECK (kind <> 'carry_forward')`,
			);
			try {
				await expect(
					redraftIssue(
						pi,
						id,
						{ title: "T2", description: "D2", needs_tests: false, carry_forward_summary: "k" },
						null,
					),
				).rejects.toThrow();
			} finally {
				await getPool().query(`ALTER TABLE comments DROP CONSTRAINT comments_no_cf`);
			}

			// Pointer unchanged: still v1. No v2 row.
			const after = await issueShowJson(pi, id, { include_history: true });
			expect(after.current_version_id).toBe(v1Detail.current_version_id);
			expect(after.current_version_no).toBe(1);
			expect(after.history).toHaveLength(1);

			// No stray phase_events row from this attempt.
			const events = await recentPhaseEvents(pi, id, 10);
			expect(events.find((e) => e.reason === "redraft")).toBeUndefined();
		});
	});
});
