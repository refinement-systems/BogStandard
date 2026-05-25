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
 * Integration test for migration 0005: merge-flow phases + issue_branches.
 *
 * Strategy:
 *   1. Spin up a DB at pre-0005 schema (through 0004) and confirm the
 *      new phases are rejected.
 *   2. Apply 0005, then confirm:
 *      - the four new phases are accepted by issues_phase_check,
 *      - an unrelated string is still rejected,
 *      - issue_branches round-trips with the expected defaults,
 *      - deleting the parent issue cascades to issue_branches.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { isPostgresAvailable, useTempDbThrough } from "./helpers/temp-db.js";

const { Client } = pg;

async function insertIssue(client: pg.Client, id: number, phase = "ready"): Promise<void> {
	await client.query(
		`INSERT INTO issues (id, priority, phase) VALUES ($1, 'low', $2)`,
		[id, phase],
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

describe.skipIf(!isPostgresAvailable())("migration 0005: merge phases reject pre-0005", () => {
	const handle = useTempDbThrough("0004_drop_parent_id.sql");
	let client: pg.Client;

	beforeAll(async () => {
		client = new Client({ connectionString: handle.url() });
		await client.connect();
	}, 60_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
	});

	it("issues_phase_check rejects merging_pending before 0005 is applied", async () => {
		await expect(
			client.query(`INSERT INTO issues (priority, phase) VALUES ('low', 'merging_pending')`),
		).rejects.toThrow(/issues_phase_check/);
	});

	it("issue_branches table does not exist before 0005", async () => {
		const res = await client.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'issue_branches') AS exists`,
		);
		expect(res.rows[0].exists).toBe(false);
	});
});

describe.skipIf(!isPostgresAvailable())("migration 0005: merge phases + issue_branches", () => {
	const handle = useTempDbThrough("0004_drop_parent_id.sql");
	let client: pg.Client;

	beforeAll(async () => {
		await handle.applyThrough("0005_merge_phases.sql");
		client = new Client({ connectionString: handle.url() });
		await client.connect();
	}, 60_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
	});

	const newPhases = ["merging_pending", "merging", "merge_repair", "merge_failed"] as const;

	it.each(newPhases)("issues_phase_check accepts %s after 0005", async (phase) => {
		await client.query(
			`INSERT INTO issues (priority, phase) VALUES ('low', $1)`,
			[phase],
		);
		const res = await client.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM issues WHERE phase = $1`,
			[phase],
		);
		expect(Number(res.rows[0].n)).toBeGreaterThanOrEqual(1);
	});

	it("issues_phase_check still rejects an unknown phase", async () => {
		await expect(
			client.query(`INSERT INTO issues (priority, phase) VALUES ('low', 'still-banana')`),
		).rejects.toThrow(/issues_phase_check/);
	});

	it("issue_branches table exists with the expected columns", async () => {
		const cols = await client.query<{ column_name: string; is_nullable: string }>(
			`SELECT column_name, is_nullable FROM information_schema.columns
			   WHERE table_name = 'issue_branches'`,
		);
		const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
		expect(byName.get("issue_id")).toBe("NO");
		expect(byName.get("ref_name")).toBe("NO");
		expect(byName.get("head_sha")).toBe("NO");
		expect(byName.get("base_sha")).toBe("NO");
		expect(byName.get("published_at")).toBe("NO");
		expect(byName.get("merged_at")).toBe("YES");
		expect(byName.get("merge_sha")).toBe("YES");
	});

	it("issue_branches uses issue_id as the primary key", async () => {
		const res = await client.query<{ attname: string }>(
			`SELECT a.attname
			   FROM pg_index i
			   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			  WHERE i.indrelid = 'issue_branches'::regclass AND i.indisprimary`,
		);
		expect(res.rows.map((r) => r.attname)).toEqual(["issue_id"]);
	});

	it("INSERT into issue_branches round-trips with defaults", async () => {
		await insertIssue(client, 9001);
		await client.query(
			`INSERT INTO issue_branches (issue_id, ref_name, head_sha, base_sha)
			 VALUES ($1, $2, $3, $4)`,
			[9001, "refs/bogstandard/issue-9001", "deadbeef", "cafebabe"],
		);
		const res = await client.query<{
			ref_name: string;
			head_sha: string;
			base_sha: string;
			published_at: Date;
			merged_at: Date | null;
			merge_sha: string | null;
		}>(`SELECT ref_name, head_sha, base_sha, published_at, merged_at, merge_sha
		      FROM issue_branches WHERE issue_id = $1`, [9001]);
		const row = res.rows[0];
		expect(row.ref_name).toBe("refs/bogstandard/issue-9001");
		expect(row.head_sha).toBe("deadbeef");
		expect(row.base_sha).toBe("cafebabe");
		expect(row.published_at).toBeInstanceOf(Date);
		expect(row.merged_at).toBeNull();
		expect(row.merge_sha).toBeNull();
	});

	it("DELETE on issues cascades to issue_branches", async () => {
		await insertIssue(client, 9002);
		await client.query(
			`INSERT INTO issue_branches (issue_id, ref_name, head_sha, base_sha)
			 VALUES ($1, 'refs/bogstandard/issue-9002', 'aa', 'bb')`,
			[9002],
		);

		await client.query(`DELETE FROM issues WHERE id = $1`, [9002]);

		const res = await client.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM issue_branches WHERE issue_id = $1`,
			[9002],
		);
		expect(Number(res.rows[0].n)).toBe(0);
	});
});
