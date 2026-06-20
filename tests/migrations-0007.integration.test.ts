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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { isPostgresAvailable, useTempDbThrough } from "./helpers/temp-db.js";

const { Client } = pg;

describe.skipIf(!isPostgresAvailable())("migration 0007: workflow_id backfill", () => {
	const handle = useTempDbThrough("0006_merge_queue.sql");
	let client: pg.Client;

	beforeAll(async () => {
		client = new Client({ connectionString: handle.url() });
		await client.connect();

		await client.query(
			`INSERT INTO issues (id, priority, phase) VALUES
			     (1, 'low', 'ready'),
			     (2, 'low', 'ready'),
			     (3, 'low', 'drafting')`,
		);
		await client.query(
			`INSERT INTO issue_versions (id, issue_id, version_no, title, needs_tests) VALUES
			     (10, 1, 1, 'direct issue', false),
			     (20, 2, 1, 'tdd issue', true),
			     (30, 3, 1, 'unclassified issue', NULL)`,
		);
		await client.query(
			`UPDATE issues
			    SET current_version_id = v.id
			   FROM issue_versions v
			  WHERE v.issue_id = issues.id`,
		);

		await client.end();
		await handle.applyRemaining();

		client = new Client({ connectionString: handle.url() });
		await client.connect();
	}, 60_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
	});

	it("maps legacy needs_tests values to workflow_id", async () => {
		const res = await client.query<{ issue_id: string; needs_tests: boolean | null; workflow_id: string | null }>(
			`SELECT issue_id, needs_tests, workflow_id FROM issue_versions ORDER BY issue_id`,
		);
		expect(res.rows.map((r) => ({
			issue_id: Number(r.issue_id),
			needs_tests: r.needs_tests,
			workflow_id: r.workflow_id,
		}))).toEqual([
			{ issue_id: 1, needs_tests: false, workflow_id: "direct" },
			{ issue_id: 2, needs_tests: true, workflow_id: "tdd" },
			{ issue_id: 3, needs_tests: null, workflow_id: null },
		]);
	});

	it("rejects unknown workflow ids", async () => {
		await expect(
			client.query(
				`INSERT INTO issue_versions (issue_id, version_no, title, workflow_id)
				      VALUES (3, 2, 'bad workflow', 'banana')`,
			),
		).rejects.toThrow(/issue_versions_workflow_id_check/);
	});
});
