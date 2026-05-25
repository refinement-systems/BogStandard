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
 * Integration tests for the block-DAG queries:
 *   - dependencyAdd / dependencyRemove (db.ts)
 *   - CYCLE_CHECK_SQL (db.ts, single-edge cycle check)
 *   - FIND_CYCLE_SQL  (issue-picker.ts, whole-graph cycle finder)
 *
 * The string-shape regex unit tests in `tests/dependency-cycle.test.ts` and
 * `tests/issue-picker.test.ts` cover SQL structure. These tests run the
 * queries against real graphs so a swapped `$1`/`$2` or a missing predicate
 * would fail loudly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	CYCLE_CHECK_SQL,
	dependencyAdd,
	dependencyRemove,
	getPool,
	issueCreate,
} from "../agent/extensions/bogstandard/db.js";
import {
	findBlockCycle,
	findBlockCycleWith,
} from "../agent/extensions/bogstandard/issue-picker.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

async function mkIssue(title = "T"): Promise<number> {
	return issueCreate(pi, { title, priority: "low" });
}

describe.skipIf(!isPostgresAvailable())("dependencyAdd / dependencyRemove", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	it("inserts a row when the edge is fresh", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await dependencyAdd(pi, b, a);
		const rows = await getPool().query<{ blocker_id: string; blocked_id: string }>(
			`SELECT blocker_id, blocked_id FROM dependencies`,
		);
		expect(rows.rows.map((r) => [Number(r.blocker_id), Number(r.blocked_id)])).toEqual([[a, b]]);
	});

	it("rejects self-edge (JS guard fires before SQL)", async () => {
		const a = await mkIssue("A");
		await expect(dependencyAdd(pi, a, a)).rejects.toThrow(/cannot block itself/);
	});

	it("rejects duplicate edge with a friendly message (23505 → 'already blocked')", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await dependencyAdd(pi, b, a);
		await expect(dependencyAdd(pi, b, a)).rejects.toThrow(/already blocked/);
	});

	it("rejects FK violation with a friendly message (23503 → 'does not exist')", async () => {
		const a = await mkIssue("A");
		await expect(dependencyAdd(pi, 9999, a)).rejects.toThrow(/does not exist/);
		await expect(dependencyAdd(pi, a, 9999)).rejects.toThrow(/does not exist/);
	});

	it("dependencyRemove throws when no row removed", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await expect(dependencyRemove(pi, b, a)).rejects.toThrow(/No block relationship/);
	});

	it("dependencyRemove deletes the edge", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await dependencyAdd(pi, b, a);
		await dependencyRemove(pi, b, a);
		const rows = await getPool().query(`SELECT * FROM dependencies`);
		expect(rows.rowCount).toBe(0);
	});
});

describe.skipIf(!isPostgresAvailable())("CYCLE_CHECK_SQL (via dependencyAdd)", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	it("A→B exists; adding B→A is rejected", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await dependencyAdd(pi, b, a); // blocker=A → blocked=B
		await expect(dependencyAdd(pi, a, b)).rejects.toThrow(/would close a cycle/);
	});

	it("A→B→C exists; adding C→A is rejected", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		const c = await mkIssue("C");
		await dependencyAdd(pi, b, a);
		await dependencyAdd(pi, c, b);
		await expect(dependencyAdd(pi, a, c)).rejects.toThrow(/would close a cycle/);
	});

	it("A→B exists; adding C→D is accepted (no cycle)", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		const c = await mkIssue("C");
		const d = await mkIssue("D");
		await dependencyAdd(pi, b, a);
		await expect(dependencyAdd(pi, d, c)).resolves.toBeUndefined();
	});

	it("long chain: 10-node line, closing edge from tail to head is rejected", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 10; i++) ids.push(await mkIssue(`N${i}`));
		// edges: 0→1, 1→2, ..., 8→9 (blocker=i blocks blocked=i+1)
		for (let i = 0; i < 9; i++) await dependencyAdd(pi, ids[i + 1], ids[i]);
		// adding 9 blocks 0 would close the cycle 0→1→...→9→0
		await expect(dependencyAdd(pi, ids[0], ids[9])).rejects.toThrow(/would close a cycle/);
	});

	it("raw CYCLE_CHECK_SQL: returns no row when there is no path", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		const res = await getPool().query(CYCLE_CHECK_SQL, [b, a]);
		expect(res.rowCount).toBe(0);
	});

	it("raw CYCLE_CHECK_SQL: returns a row when the new edge would close a cycle", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		await dependencyAdd(pi, b, a); // A→B
		// Hypothetical edge B→A: blockedId=A, blockerId=B → walk from A forward following blocker→blocked
		const res = await getPool().query(CYCLE_CHECK_SQL, [a, b]);
		expect(res.rowCount).toBe(1);
	});
});

describe.skipIf(!isPostgresAvailable())("FIND_CYCLE_SQL", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	it("empty graph: returns null", async () => {
		expect(await findBlockCycle(pi)).toBeNull();
	});

	it("acyclic graph: returns null", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		const c = await mkIssue("C");
		await dependencyAdd(pi, b, a);
		await dependencyAdd(pi, c, b);
		expect(await findBlockCycle(pi)).toBeNull();
	});

	it("direct cycle A↔B: returns a path that starts and ends with the same id", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		// Insert the cycle directly (dependencyAdd would reject the second edge).
		await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2), ($2, $1)`, [a, b]);
		const cycle = await findBlockCycle(pi);
		expect(cycle).not.toBeNull();
		expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
		expect(new Set(cycle!.slice(0, -1)).size).toBe(cycle!.length - 1);
		expect(cycle!.length).toBe(3);
	});

	it("longer cycle A→B→C→A: returns ordered path", async () => {
		const a = await mkIssue("A");
		const b = await mkIssue("B");
		const c = await mkIssue("C");
		await getPool().query(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2), ($2, $3), ($3, $1)`,
			[a, b, c],
		);
		const cycle = await findBlockCycle(pi);
		expect(cycle).not.toBeNull();
		expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
		expect(cycle!.length).toBe(4);
		const nodes = new Set(cycle!);
		expect(nodes.has(a)).toBe(true);
		expect(nodes.has(b)).toBe(true);
		expect(nodes.has(c)).toBe(true);
	});

	it("returns SOME valid cycle when multiple cycles exist (LIMIT 1)", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 6; i++) ids.push(await mkIssue(`N${i}`));
		// Two disjoint 3-cycles.
		await getPool().query(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES
			   ($1, $2), ($2, $3), ($3, $1),
			   ($4, $5), ($5, $6), ($6, $4)`,
			ids,
		);
		const cycle = await findBlockCycle(pi);
		expect(cycle).not.toBeNull();
		expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
		expect(cycle!.length).toBe(4);
	});

	it("bounded walk: acyclic chain of 250 nodes returns null (array_length < 200 guard)", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 250; i++) ids.push(await mkIssue(`N${i}`));
		// Linear chain — no cycle.
		const params: number[] = [];
		const tuples: string[] = [];
		for (let i = 0; i < 249; i++) {
			params.push(ids[i], ids[i + 1]);
			tuples.push(`($${params.length - 1}, $${params.length})`);
		}
		await getPool().query(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ${tuples.join(", ")}`,
			params,
		);
		const cycle = await findBlockCycle(pi);
		expect(cycle).toBeNull();
	}, 30_000);

	it("findBlockCycleWith returns null when run against a pool with an empty graph", async () => {
		expect(await findBlockCycleWith(getPool())).toBeNull();
	});
});
