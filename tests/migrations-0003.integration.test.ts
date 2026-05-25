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
 * Integration test for migration 0003: status → phase + version backfill.
 *
 * Strategy:
 *   1. Spin up an empty temp DB.
 *   2. Apply migrations 0001 + 0002 only.
 *   3. Populate `issues`, `comments`, `dependencies`, and `locks` as if this
 *      were a pre-0003 chainlink database.
 *   4. Apply 0003.
 *   5. Assert the backfill landed correctly.
 *
 * One test file = one temp DB (because `useTempDbThrough` registers per-file
 * lifecycle hooks). We run all the migration assertions in a single
 * back-to-back fixture rather than fighting per-test isolation, because once
 * 0003 is applied it can't be undone within the same DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { isPostgresAvailable, useTempDbThrough } from "./helpers/temp-db.js";

const { Client } = pg;

interface BackfillRow {
	id: number;
	title: string;
	description: string | null;
	status: "open" | "draft" | "closed" | "archived" | string;
	priority: "low" | "medium" | "high" | "critical";
}

describe.skipIf(!isPostgresAvailable())("migration 0003: status → phase + version backfill", () => {
	const handle = useTempDbThrough("0002_draft_status.sql");
	let client: pg.Client;

	const issuesSpec: BackfillRow[] = [
		{ id: 1, title: "Open issue",     description: "Open body",     status: "open",     priority: "high" },
		{ id: 2, title: "Draft issue",    description: "Draft body",    status: "draft",    priority: "medium" },
		{ id: 3, title: "Closed issue",   description: "Closed body",   status: "closed",   priority: "low" },
		{ id: 4, title: "Archived issue", description: "Archived body", status: "archived", priority: "critical" },
	];

	beforeAll(async () => {
		client = new Client({ connectionString: handle.url() });
		await client.connect();

		for (const r of issuesSpec) {
			await client.query(
				`INSERT INTO issues (id, title, description, status, priority) VALUES ($1, $2, $3, $4, $5)`,
				[r.id, r.title, r.description, r.status, r.priority],
			);
		}
		// Comments scoped to the chainlink-era schema (no version_id column yet).
		await client.query(`INSERT INTO comments (issue_id, kind, content) VALUES (1, 'note', 'on open')`);
		await client.query(`INSERT INTO comments (issue_id, kind, content) VALUES (3, 'plan', 'on closed')`);
		// A dependency edge (already exists in 0001).
		await client.query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES (1, 2)`);
		// A row in `locks` to assert it gets dropped.
		await client.query(`INSERT INTO locks (issue_id, agent_id) VALUES (1, 'oldagent')`);

		await client.end();

		await handle.applyThrough("0003_phase_state_and_versioning.sql");

		client = new Client({ connectionString: handle.url() });
		await client.connect();
	}, 60_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
	});

	it("creates exactly one v1 in issue_versions per issue with copied title/description", async () => {
		const res = await client.query<{ issue_id: string; version_no: number; title: string; description: string | null }>(
			`SELECT issue_id, version_no, title, description FROM issue_versions ORDER BY issue_id`,
		);
		expect(res.rows.map((r) => Number(r.issue_id))).toEqual([1, 2, 3, 4]);
		for (const r of res.rows) {
			expect(r.version_no).toBe(1);
			const expected = issuesSpec.find((x) => x.id === Number(r.issue_id))!;
			expect(r.title).toBe(expected.title);
			expect(r.description).toBe(expected.description);
		}
	});

	it("maps status → phase: open→ready, draft→drafting, closed→done, archived→archived", async () => {
		const res = await client.query<{ id: string; phase: string }>(`SELECT id, phase FROM issues ORDER BY id`);
		const byId = new Map(res.rows.map((r) => [Number(r.id), r.phase]));
		expect(byId.get(1)).toBe("ready");
		expect(byId.get(2)).toBe("drafting");
		expect(byId.get(3)).toBe("done");
		expect(byId.get(4)).toBe("archived");
	});

	it("sets current_version_id to the v1 row", async () => {
		const res = await client.query<{ id: string; current_version_id: string | null }>(
			`SELECT i.id, i.current_version_id FROM issues i ORDER BY i.id`,
		);
		expect(res.rows.every((r) => r.current_version_id !== null)).toBe(true);
		// Each pointer matches the v1 row's id for that issue.
		for (const r of res.rows) {
			const v1 = await client.query<{ id: string }>(
				`SELECT id FROM issue_versions WHERE issue_id = $1 AND version_no = 1`,
				[r.id],
			);
			expect(Number(r.current_version_id)).toBe(Number(v1.rows[0].id));
		}
	});

	it("backfills comments.version_id to the v1 row", async () => {
		const res = await client.query<{ id: string; issue_id: string; version_id: string | null }>(
			`SELECT id, issue_id, version_id FROM comments ORDER BY id`,
		);
		expect(res.rowCount).toBe(2);
		for (const c of res.rows) {
			expect(c.version_id).not.toBeNull();
			const v1 = await client.query<{ id: string }>(
				`SELECT id FROM issue_versions WHERE issue_id = $1 AND version_no = 1`,
				[c.issue_id],
			);
			expect(Number(c.version_id)).toBe(Number(v1.rows[0].id));
		}
	});

	it("drops the locks table", async () => {
		const res = await client.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'locks') AS exists`,
		);
		expect(res.rows[0].exists).toBe(false);
	});

	it("drops issues.status, issues.title, issues.description, idx_issues_status", async () => {
		const cols = await client.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues'`,
		);
		const names = cols.rows.map((r) => r.column_name);
		expect(names).not.toContain("status");
		expect(names).not.toContain("title");
		expect(names).not.toContain("description");

		const idx = await client.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'issues' AND indexname = 'idx_issues_status'`,
		);
		expect(idx.rowCount).toBe(0);
	});

	it("issues.phase is NOT NULL", async () => {
		const col = await client.query<{ is_nullable: string }>(
			`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'phase'`,
		);
		expect(col.rows[0].is_nullable).toBe("NO");
	});

	it("issues.phase CHECK rejects an unknown phase after migration", async () => {
		await expect(
			client.query(`INSERT INTO issues (priority, phase) VALUES ('low', 'banana')`),
		).rejects.toThrow(/issues_phase_check/);
	});

	it("phase_events table exists with the expected columns", async () => {
		const cols = await client.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_name = 'phase_events'`,
		);
		const names = new Set(cols.rows.map((r) => r.column_name));
		for (const expected of ["id", "issue_id", "version_id", "phase_from", "phase_to", "agent_id", "reason", "metadata", "created_at"]) {
			expect(names.has(expected)).toBe(true);
		}
	});

	it("backfilled v1 rows have needs_tests NULL (legacy issues must be classified before /bs-task)", async () => {
		const res = await client.query<{ needs_tests: boolean | null }>(
			`SELECT needs_tests FROM issue_versions`,
		);
		for (const r of res.rows) expect(r.needs_tests).toBeNull();
	});
});
