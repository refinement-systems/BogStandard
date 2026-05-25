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
 * Integration tests for ELIGIBLE_SQL.
 *
 * The picker query is the brain of /bs-task. The unit suite only asserts on
 * its string shape; here we drive real rows through the production entry
 * points (`issueCreate`, `transitionPhase`, `claimIssue`, `dependencyAdd`)
 * and assert on what `listEligible` actually returns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	claimIssue,
	dependencyAdd,
	getPool,
	issueCreate,
	transitionPhase,
} from "../agent/extensions/bogstandard/db.js";
import { listEligible } from "../agent/extensions/bogstandard/issue-picker.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";

// db.ts functions ignore the pi argument; pass a stub to satisfy the signature.
const pi = {} as ExtensionAPI;

async function makeReady(title: string, priority: "low" | "medium" | "high" | "critical" = "high"): Promise<number> {
	return issueCreate(pi, { title, priority, needs_tests: true, phase: "ready" });
}

describe.skipIf(!isPostgresAvailable())("ELIGIBLE_SQL", () => {
	useTempDb();

	beforeEach(async () => {
		await getPool().query(
			`TRUNCATE phase_events, comments, dependencies, issue_versions, issues RESTART IDENTITY CASCADE`,
		);
	});

	it("returns nothing on an empty database", async () => {
		expect(await listEligible(pi, 60)).toEqual([]);
	});

	it("requires phase='ready' AND needs_tests IS NOT NULL", async () => {
		const eligibleId = await makeReady("eligible");
		// drafting issue with correct needs_tests — not yet promoted
		await issueCreate(pi, { title: "drafting", priority: "high", needs_tests: true });
		// ready issue without needs_tests classified — picker rejects on the gate
		await issueCreate(pi, { title: "unclassified", priority: "high", phase: "ready" });

		expect((await listEligible(pi, 60)).map((r) => r.id)).toEqual([eligibleId]);
	});

	it("treats 'done' and 'archived' blockers as resolved; 'aborted' and active blockers still block", async () => {
		const blockerDone = await makeReady("blocker-done");
		const blockerArchived = await makeReady("blocker-archived");
		const blockerAborted = await makeReady("blocker-aborted");
		const blockerReady = await makeReady("blocker-ready");

		await transitionPhase(pi, { issueId: blockerDone, from: "ready", to: "done", agentId: null });
		await transitionPhase(pi, { issueId: blockerArchived, from: "ready", to: "archived", agentId: null });
		await transitionPhase(pi, { issueId: blockerAborted, from: "ready", to: "aborted", agentId: null });
		// blockerReady stays in 'ready' — itself eligible until something blocks it

		const blockedByDone = await makeReady("blocked-by-done");
		const blockedByArchived = await makeReady("blocked-by-archived");
		const blockedByAborted = await makeReady("blocked-by-aborted");
		const blockedByReady = await makeReady("blocked-by-ready");

		await dependencyAdd(pi, blockedByDone, blockerDone);
		await dependencyAdd(pi, blockedByArchived, blockerArchived);
		await dependencyAdd(pi, blockedByAborted, blockerAborted);
		await dependencyAdd(pi, blockedByReady, blockerReady);

		const ids = new Set((await listEligible(pi, 60)).map((r) => r.id));
		expect(ids.has(blockedByDone)).toBe(true);
		expect(ids.has(blockedByArchived)).toBe(true);
		expect(ids.has(blockerReady)).toBe(true);
		expect(ids.has(blockedByAborted)).toBe(false);
		expect(ids.has(blockedByReady)).toBe(false);
	});

	it("excludes fresh claims; includes claims older than the stale threshold", async () => {
		const id = await makeReady("claimed");
		expect(await claimIssue(pi, id, "alice", 60)).toBe(true);

		expect((await listEligible(pi, 60)).map((r) => r.id)).not.toContain(id);

		// Backdate the claim. Raw SQL is unavoidable here — production has no
		// time-travel API and we need to simulate a stuck agent.
		await getPool().query(
			`UPDATE issues SET phase_started_at = now() - interval '90 minutes' WHERE id = $1`,
			[id],
		);

		expect((await listEligible(pi, 60)).map((r) => r.id)).toContain(id);
		expect((await listEligible(pi, 120)).map((r) => r.id)).not.toContain(id);
	});

	it("orders results by priority (critical, high, medium, low) then id", async () => {
		const lowId = await makeReady("L", "low");
		const critId = await makeReady("C", "critical");
		const medId1 = await makeReady("M1", "medium");
		const highId = await makeReady("H", "high");
		const medId2 = await makeReady("M2", "medium");

		const ids = (await listEligible(pi, 60)).map((r) => r.id);
		expect(ids).toEqual([critId, highId, medId1, medId2, lowId]);
	});

	it("owner-set but phase_started_at NULL is still claimed (NULL < interval is NULL, not true)", async () => {
		// In Read Committed Postgres, `NULL < now() - interval` evaluates to NULL,
		// which is filtered out by the WHERE clause. So an issue with an agent
		// id set but no heartbeat is treated as freshly claimed and excluded.
		const id = await makeReady("orphan-claim");
		await getPool().query(
			`UPDATE issues SET current_agent_id = 'ghost', phase_started_at = NULL WHERE id = $1`,
			[id],
		);
		const ids = (await listEligible(pi, 60)).map((r) => r.id);
		expect(ids).not.toContain(id);
	});

	// Note: the priority `ELSE 4` branch (issue-picker.ts ELIGIBLE_SQL) is
	// unreachable here because the issues.priority CHECK constraint rejects
	// any value outside ('low', 'medium', 'high', 'critical'). The ELSE 4
	// arm is dead code in the current schema; if the CHECK ever loosens,
	// add an integration test that inserts an issue with the new priority.
});
