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
 * DB-level backstops. Each test fires a raw `getPool().query()` expected
 * to throw because of a CHECK / UNIQUE / FK constraint, or to observe
 * cascade behavior. These exist alongside JS-level validation (assertPriority,
 * the self-edge guard in dependencyAdd) to catch direct-SQL bypasses and
 * import paths.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getPool,
	issueCreate,
	transitionPhase,
} from "../agent/extensions/bogstandard/db.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

describe.skipIf(!isPostgresAvailable())("schema constraints", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	describe("CHECK constraints", () => {
		it("issues.phase rejects unknown value", async () => {
			await expect(
				getPool().query(`INSERT INTO issues (priority, phase) VALUES ('low', 'banana')`),
			).rejects.toThrow(/issues_phase_check/);
		});

		it("issues.priority rejects unknown value", async () => {
			await expect(
				getPool().query(`INSERT INTO issues (priority, phase) VALUES ('urgent', 'drafting')`),
			).rejects.toThrow(/issues_priority_check/);
		});

		it("agent_config single-row CHECK: only id=1 is allowed", async () => {
			await getPool().query(`INSERT INTO agent_config (id, agent_id) VALUES (1, 'main')`);
			await expect(
				getPool().query(`INSERT INTO agent_config (id, agent_id) VALUES (2, 'other')`),
			).rejects.toThrow(/agent_config_id_check|agent_config_pkey/);
		});

		it("agent_config PK rejects a second row with id=1", async () => {
			await getPool().query(`INSERT INTO agent_config (id, agent_id) VALUES (1, 'main')`);
			await expect(
				getPool().query(`INSERT INTO agent_config (id, agent_id) VALUES (1, 'other')`),
			).rejects.toThrow(/agent_config_pkey/);
		});

		it("dependencies self-edge CHECK rejects blocker = blocked", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(
				getPool().query(
					`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $1)`,
					[id],
				),
			).rejects.toThrow(/dependencies_check/);
		});

		it("dependencies PK rejects duplicate (blocker_id, blocked_id)", async () => {
			const a = await issueCreate(pi, { title: "A", priority: "low" });
			const b = await issueCreate(pi, { title: "B", priority: "low" });
			await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [a, b]);
			await expect(
				getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [a, b]),
			).rejects.toThrow(/dependencies_pkey/);
		});

		it("issue_versions UNIQUE (issue_id, version_no) rejects duplicate", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(
				getPool().query(
					`INSERT INTO issue_versions (issue_id, version_no, title) VALUES ($1, 1, 'dup')`,
					[id],
				),
			).rejects.toThrow(/issue_versions_issue_id_version_no_key/);
		});
	});

	describe("FK ON DELETE CASCADE", () => {
		async function makeIssueWithEverything(): Promise<number> {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: true });
			await getPool().query(`INSERT INTO comments (issue_id, version_id, kind, content)
			      VALUES ($1, (SELECT current_version_id FROM issues WHERE id = $1), 'note', 'c1')`, [id]);
			const other = await issueCreate(pi, { title: "Other", priority: "low" });
			await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [other, id]);
			await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [id, other]);
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: null });
			return id;
		}

		it("deleting an issue cascades to comments / dependencies (both sides) / issue_versions / phase_events", async () => {
			const id = await makeIssueWithEverything();
			await getPool().query(`DELETE FROM issues WHERE id = $1`, [id]);

			const c = await getPool().query(`SELECT count(*)::int AS n FROM comments WHERE issue_id = $1`, [id]);
			const d1 = await getPool().query(`SELECT count(*)::int AS n FROM dependencies WHERE blocked_id = $1`, [id]);
			const d2 = await getPool().query(`SELECT count(*)::int AS n FROM dependencies WHERE blocker_id = $1`, [id]);
			const v = await getPool().query(`SELECT count(*)::int AS n FROM issue_versions WHERE issue_id = $1`, [id]);
			const p = await getPool().query(`SELECT count(*)::int AS n FROM phase_events WHERE issue_id = $1`, [id]);
			expect(c.rows[0].n).toBe(0);
			expect(d1.rows[0].n).toBe(0);
			expect(d2.rows[0].n).toBe(0);
			expect(v.rows[0].n).toBe(0);
			expect(p.rows[0].n).toBe(0);
		});
	});

	describe("FK ON DELETE SET NULL on phase_events.version_id", () => {
		it("deleting a version sets matching phase_events.version_id to NULL while keeping the row", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: true });
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: null });
			const vid = await getPool().query<{ id: string }>(
				`SELECT current_version_id AS id FROM issues WHERE id = $1`,
				[id],
			);
			const versionId = Number(vid.rows[0].id);

			// Detach the issue's pointer so we can delete the version without FK trouble on issues.current_version_id.
			await getPool().query(`UPDATE issues SET current_version_id = NULL WHERE id = $1`, [id]);
			await getPool().query(`DELETE FROM issue_versions WHERE id = $1`, [versionId]);

			const events = await getPool().query<{ version_id: string | null }>(
				`SELECT version_id FROM phase_events WHERE issue_id = $1`,
				[id],
			);
			expect(events.rowCount).toBeGreaterThan(0);
			for (const e of events.rows) {
				expect(e.version_id).toBeNull();
			}
		});
	});

	describe("comments.version_id NOT NULL post-0003", () => {
		it("rejects inserts without a version_id", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(
				getPool().query(
					`INSERT INTO comments (issue_id, kind, content) VALUES ($1, 'note', 'hi')`,
					[id],
				),
			).rejects.toThrow(/null value in column "version_id"|not-null/);
		});
	});
});
