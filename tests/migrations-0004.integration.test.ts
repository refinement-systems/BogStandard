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
 * Integration test for migration 0004: parent_id → dependencies backfill +
 * cycle rejection.
 *
 * Strategy:
 *   The happy-path tests use the per-file `useTempDbThrough` helper to
 *   spin up a DB at 0003, seed parent_id chains, apply 0004, and assert.
 *   The cycle-rejection test must run against a SEPARATE temp DB (otherwise
 *   the failed 0004 application leaves pgmigrations in a bad state), so it
 *   creates and tears down its own DB inline.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
	applyMigrationsThrough,
	createDatabase,
	dropDatabase,
	isPostgresAvailable,
	randomDbName,
	urlForDb,
	useTempDbThrough,
} from "./helpers/temp-db.js";

const { Client } = pg;

async function insertIssue(client: pg.Client, id: number, parentId: number | null = null): Promise<void> {
	// Bypass FK by inserting parents first; this helper inserts a single issue
	// at a post-0003 schema (no title/description on `issues`, but with phase).
	await client.query(
		`INSERT INTO issues (id, priority, phase, parent_id) VALUES ($1, 'low', 'ready', $2)`,
		[id, parentId],
	);
	await client.query(
		`INSERT INTO issue_versions (issue_id, version_no, title) VALUES ($1, 1, $2)`,
		[id, `I${id}`],
	);
	await client.query(
		`UPDATE issues SET current_version_id = (SELECT id FROM issue_versions WHERE issue_id = $1 AND version_no = 1) WHERE id = $1`,
		[id],
	);
}

describe.skipIf(!isPostgresAvailable())("migration 0004: parent_id → dependencies backfill", () => {
	const handle = useTempDbThrough("0003_phase_state_and_versioning.sql");
	let client: pg.Client;

	beforeAll(async () => {
		client = new Client({ connectionString: handle.url() });
		await client.connect();

		// Linear chain: 1 ← 2 ← 3 (3 is child of 2, 2 is child of 1).
		await insertIssue(client, 1, null);
		await insertIssue(client, 2, 1);
		await insertIssue(client, 3, 2);
		// Branching: 4 is parent of both 5 and 6.
		await insertIssue(client, 4, null);
		await insertIssue(client, 5, 4);
		await insertIssue(client, 6, 4);
		// Orphan: 7 has no parent and no dependents.
		await insertIssue(client, 7, null);
		// Pre-existing dependency edge that overlaps a parent_id edge (idempotency check).
		await client.query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES (2, 1)`);

		await client.end();

		await handle.applyRemaining(); // applies 0004

		client = new Client({ connectionString: handle.url() });
		await client.connect();
	}, 60_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
	});

	it("converts every parent_id row into a child→parent dependency", async () => {
		const res = await client.query<{ blocker_id: string; blocked_id: string }>(
			`SELECT blocker_id, blocked_id FROM dependencies ORDER BY blocker_id, blocked_id`,
		);
		const edges = res.rows.map((r) => [Number(r.blocker_id), Number(r.blocked_id)]);
		// Expected edges (child blocks parent): (2,1), (3,2), (5,4), (6,4).
		expect(edges).toContainEqual([2, 1]);
		expect(edges).toContainEqual([3, 2]);
		expect(edges).toContainEqual([5, 4]);
		expect(edges).toContainEqual([6, 4]);
	});

	it("pre-existing edge that overlaps a parent edge stays unique (ON CONFLICT DO NOTHING)", async () => {
		const res = await client.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM dependencies WHERE blocker_id = 2 AND blocked_id = 1`,
		);
		expect(Number(res.rows[0].n)).toBe(1);
	});

	it("drops parent_id column and idx_issues_parent", async () => {
		const cols = await client.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues'`,
		);
		const names = cols.rows.map((r) => r.column_name);
		expect(names).not.toContain("parent_id");

		const idx = await client.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'issues' AND indexname = 'idx_issues_parent'`,
		);
		expect(idx.rowCount).toBe(0);
	});

	it("leaves orphan issues without any new edges", async () => {
		const res = await client.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM dependencies WHERE blocker_id = 7 OR blocked_id = 7`,
		);
		expect(Number(res.rows[0].n)).toBe(0);
	});

	it("total edge count matches expected", async () => {
		const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM dependencies`);
		// 4 from parent_id + 0 net-new from pre-existing (deduped).
		expect(Number(res.rows[0].n)).toBe(4);
	});
});

describe.skipIf(!isPostgresAvailable())("migration 0004: cycle rejection", () => {
	it("RAISES EXCEPTION when the backfilled graph contains a cycle, leaving the schema unchanged", async () => {
		const dbName = randomDbName();
		const dbUrl = urlForDb(dbName);
		await createDatabase(dbName);

		try {
			await applyMigrationsThrough(dbUrl, "0003_phase_state_and_versioning.sql");

			const seed = new Client({ connectionString: dbUrl });
			await seed.connect();
			try {
				// Build a 3-cycle in parent_id: 1 ← 2, 2 ← 3, 3 ← 1.
				// FK self-ref means we must insert all with parent_id=NULL first, then UPDATE.
				await insertIssue(seed, 1, null);
				await insertIssue(seed, 2, 1);
				await insertIssue(seed, 3, 2);
				await seed.query(`UPDATE issues SET parent_id = 3 WHERE id = 1`);

				// Confirm parent_id column still present pre-0004.
				const before = await seed.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'parent_id'`,
				);
				expect(before.rowCount).toBe(1);
			} finally {
				await seed.end();
			}

			// Apply 0004 — must throw because of the cycle.
			await expect(applyMigrationsThrough(dbUrl, "0004_drop_parent_id.sql")).rejects.toThrow(
				/Block-graph cycle detected after backfill/,
			);

			// State unchanged: parent_id column still present, no rows in dependencies.
			const verify = new Client({ connectionString: dbUrl });
			await verify.connect();
			try {
				const cols = await verify.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'parent_id'`,
				);
				expect(cols.rowCount).toBe(1);

				const deps = await verify.query<{ n: string }>(`SELECT count(*)::text AS n FROM dependencies`);
				expect(Number(deps.rows[0].n)).toBe(0);
			} finally {
				await verify.end();
			}
		} finally {
			await dropDatabase(dbName);
		}
	}, 60_000);
});
