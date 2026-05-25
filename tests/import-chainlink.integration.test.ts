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
 * Tests for `scripts/import-from-chainlink.ts`.
 *
 * Pure helpers (`chainlinkStatusToPhase`) run as plain unit tests. The
 * DB-touching helpers use the per-file temp DB and the chainlink SQLite
 * fixture (see tests/helpers/chainlink-fixture.ts).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureDb, getPool, issueCreate, type Phase } from "../agent/extensions/bogstandard/db.js";
import {
	assertNoCycles,
	assertTargetEmpty,
	chainlinkStatusToPhase,
	migrateAgentJson,
	migrateComments,
	migrateDeps,
	migrateIssues,
	type ChainlinkComment,
	type ChainlinkDep,
	type ChainlinkIssue,
} from "../scripts/import-from-chainlink.js";
import { makeChainlinkFixture } from "./helpers/chainlink-fixture.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const { Client } = pg;

describe("chainlinkStatusToPhase (pure)", () => {
	it.each<[string, string]>([
		["open", "ready"],
		["draft", "drafting"],
		["closed", "done"],
		["archived", "archived"],
	])("'%s' → '%s'", (input, expected) => {
		expect(chainlinkStatusToPhase(input)).toBe(expected);
	});

	it("unknown status falls back to 'ready'", () => {
		expect(chainlinkStatusToPhase("banana")).toBe("ready");
		expect(chainlinkStatusToPhase("")).toBe("ready");
	});
});

describe.skipIf(!isPostgresAvailable())("import helpers", () => {
	const handle = useTempDb();
	let client: pg.Client;

	beforeEach(async () => {
		await truncateAll();
		client = new Client({ connectionString: handle.url() });
		await client.connect();
	});

	afterEach(async () => {
		await client.end();
	});

	describe("assertTargetEmpty", () => {
		it("passes on an empty DB", async () => {
			await expect(assertTargetEmpty(client, false)).resolves.toBeUndefined();
		});

		it("throws on a non-empty DB without force", async () => {
			// Seed via the same pool as the production app would.
			await issueCreate({} as never, { title: "T", priority: "low" });
			await expect(assertTargetEmpty(client, false)).rejects.toThrow(/Refusing to migrate without --force/);
		});

		it("passes on a non-empty DB with force", async () => {
			await issueCreate({} as never, { title: "T", priority: "low" });
			await expect(assertTargetEmpty(client, true)).resolves.toBeUndefined();
		});
	});

	describe("migrateIssues", () => {
		it("preserves ids and bumps issues_id_seq so issueCreate after import doesn't collide", async () => {
			const rows: ChainlinkIssue[] = [
				{ id: 5, title: "I5", description: "D5", status: "open", priority: "high", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
				{ id: 7, title: "I7", description: "D7", status: "closed", priority: "low", parent_id: 5, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
			];
			await client.query("BEGIN");
			const map = await migrateIssues(client, rows);
			await client.query("COMMIT");

			expect(map.size).toBe(2);

			const ids = await client.query<{ id: string; phase: string; priority: string }>(
				`SELECT id, phase, priority FROM issues ORDER BY id`,
			);
			expect(ids.rows.map((r) => Number(r.id))).toEqual([5, 7]);
			expect(ids.rows.map((r) => r.phase)).toEqual(["ready", "done"]);
			expect(ids.rows.map((r) => r.priority)).toEqual(["high", "low"]);

			// Subsequent issueCreate should not collide on the PK.
			const nextId = await issueCreate({} as never, { title: "T2", priority: "low" });
			expect(nextId).toBeGreaterThan(7);

			// parent_id was converted into a dependency edge (child blocks parent).
			const deps = await client.query<{ blocker_id: string; blocked_id: string }>(
				`SELECT blocker_id, blocked_id FROM dependencies`,
			);
			expect(deps.rows.map((r) => [Number(r.blocker_id), Number(r.blocked_id)])).toContainEqual([7, 5]);
		});

		it("creates a v1 issue_versions row per issue with copied title/description", async () => {
			const rows: ChainlinkIssue[] = [
				{ id: 3, title: "T3", description: "D3", status: "open", priority: "low", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
			];
			await client.query("BEGIN");
			await migrateIssues(client, rows);
			await client.query("COMMIT");

			const v = await client.query<{ version_no: number; title: string; description: string | null; needs_tests: boolean | null }>(
				`SELECT version_no, title, description, needs_tests FROM issue_versions WHERE issue_id = 3`,
			);
			expect(v.rows).toEqual([{ version_no: 1, title: "T3", description: "D3", needs_tests: null }]);
		});
	});

	describe("migrateComments", () => {
		it("preserves ids and bumps comments_id_seq", async () => {
			const issueRows: ChainlinkIssue[] = [
				{ id: 1, title: "T", description: null, status: "open", priority: "low", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
			];
			const commentRows: ChainlinkComment[] = [
				{ id: 10, issue_id: 1, content: "first",  created_at: "2024-01-01", kind: "note" },
				{ id: 11, issue_id: 1, content: "second", created_at: "2024-01-01", kind: null },
			];
			await client.query("BEGIN");
			const map = await migrateIssues(client, issueRows);
			await migrateComments(client, commentRows, map);
			await client.query("COMMIT");

			const c = await client.query<{ id: string; kind: string; content: string; version_id: string }>(
				`SELECT id, kind, content, version_id FROM comments ORDER BY id`,
			);
			expect(c.rows.map((r) => Number(r.id))).toEqual([10, 11]);
			expect(c.rows.map((r) => r.kind)).toEqual(["note", "note"]); // null defaults to "note"

			// All comments attached to the v1 row of issue #1.
			const v1 = await client.query<{ id: string }>(
				`SELECT id FROM issue_versions WHERE issue_id = 1 AND version_no = 1`,
			);
			for (const r of c.rows) {
				expect(Number(r.version_id)).toBe(Number(v1.rows[0].id));
			}

			// Subsequent comment insert via the app shouldn't collide.
			const issueId = 1;
			const vid = await client.query<{ id: string }>(
				`SELECT current_version_id AS id FROM issues WHERE id = $1`,
				[issueId],
			);
			const insert = await client.query<{ id: string }>(
				`INSERT INTO comments (issue_id, version_id, kind, content) VALUES ($1, $2, 'note', 'next') RETURNING id`,
				[issueId, Number(vid.rows[0].id)],
			);
			expect(Number(insert.rows[0].id)).toBeGreaterThan(11);
		});

		it("skips orphan comments with a warning", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await client.query("BEGIN");
				const orphans: ChainlinkComment[] = [
					{ id: 99, issue_id: 9999, content: "orphan", created_at: "2024-01-01", kind: "note" },
				];
				await migrateComments(client, orphans, new Map());
				await client.query("COMMIT");
				expect(warn).toHaveBeenCalled();
				expect(warn.mock.calls[0][0]).toMatch(/issue #9999 not imported/);
			} finally {
				warn.mockRestore();
			}
			const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM comments`);
			expect(Number(n.rows[0].n)).toBe(0);
		});
	});

	describe("migrateDeps", () => {
		it("inserts ON CONFLICT DO NOTHING — duplicates don't error", async () => {
			const issueRows: ChainlinkIssue[] = [
				{ id: 1, title: "A", description: null, status: "open", priority: "low", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
				{ id: 2, title: "B", description: null, status: "open", priority: "low", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
			];
			const deps: ChainlinkDep[] = [
				{ blocker_id: 1, blocked_id: 2 },
				{ blocker_id: 1, blocked_id: 2 }, // duplicate — should be silently absorbed
			];
			await client.query("BEGIN");
			await migrateIssues(client, issueRows);
			await migrateDeps(client, deps);
			await client.query("COMMIT");

			const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM dependencies WHERE blocker_id = 1 AND blocked_id = 2`);
			expect(Number(res.rows[0].n)).toBe(1);
		});
	});

	describe("migrateAgentJson", () => {
		it("skipped when file missing", async () => {
			const fx = makeChainlinkFixture({ agent: null });
			try {
				await migrateAgentJson(client, fx.agentJsonPath);
				const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_config`);
				expect(Number(n.rows[0].n)).toBe(0);
			} finally {
				fx.dispose();
			}
		});

		it("skipped on malformed JSON (with warning)", async () => {
			const fx = makeChainlinkFixture({ agent: null });
			try {
				writeFileSync(join(fx.dir, "agent.json"), "{ not valid json");
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await migrateAgentJson(client, join(fx.dir, "agent.json"));
					expect(warn).toHaveBeenCalled();
				} finally {
					warn.mockRestore();
				}
				const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_config`);
				expect(Number(n.rows[0].n)).toBe(0);
			} finally {
				fx.dispose();
			}
		});

		it("skipped when JSON has no agent_id", async () => {
			const fx = makeChainlinkFixture({ agent: { description: "no id" } });
			try {
				await migrateAgentJson(client, fx.agentJsonPath);
				const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_config`);
				expect(Number(n.rows[0].n)).toBe(0);
			} finally {
				fx.dispose();
			}
		});

		it("happy path UPSERTs the agent_config row", async () => {
			const fx = makeChainlinkFixture({ agent: { agent_id: "alpha", description: "first" } });
			try {
				await migrateAgentJson(client, fx.agentJsonPath);
				const row = await client.query<{ agent_id: string; description: string | null }>(`SELECT agent_id, description FROM agent_config`);
				expect(row.rows[0]).toEqual({ agent_id: "alpha", description: "first" });

				// Re-run with different values — UPSERT updates the same row.
				writeFileSync(fx.agentJsonPath, JSON.stringify({ agent_id: "beta" }));
				await migrateAgentJson(client, fx.agentJsonPath);
				const row2 = await client.query<{ agent_id: string; description: string | null }>(`SELECT agent_id, description FROM agent_config`);
				expect(row2.rows[0]).toEqual({ agent_id: "beta", description: null });
				const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_config`);
				expect(Number(n.rows[0].n)).toBe(1);
			} finally {
				fx.dispose();
			}
		});
	});

	describe("assertNoCycles", () => {
		it("clean graph passes", async () => {
			await client.query(`INSERT INTO issues (id, priority, phase) VALUES (1, 'low', 'ready'), (2, 'low', 'ready')`);
			await client.query(`INSERT INTO issue_versions (issue_id, version_no, title) VALUES (1, 1, 'A'), (2, 1, 'B')`);
			await client.query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES (1, 2)`);
			await expect(assertNoCycles(client)).resolves.toBeUndefined();
		});

		it("cyclic graph throws with formatted path", async () => {
			await client.query(`INSERT INTO issues (id, priority, phase) VALUES (1, 'low', 'ready'), (2, 'low', 'ready')`);
			await client.query(`INSERT INTO issue_versions (issue_id, version_no, title) VALUES (1, 1, 'A'), (2, 1, 'B')`);
			await client.query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES (1, 2), (2, 1)`);
			await expect(assertNoCycles(client)).rejects.toThrow(/Imported block graph contains a cycle: #/);
		});
	});

	describe("end-to-end import", () => {
		it("full sqlite fixture → pg with correct row counts and phase mappings", async () => {
			const fx = makeChainlinkFixture({
				issues: [
					{ id: 1, title: "Open",     status: "open",     priority: "high"     },
					{ id: 2, title: "Draft",    status: "draft",    priority: "medium"   },
					{ id: 3, title: "Closed",   status: "closed",   priority: "low"      },
					{ id: 4, title: "Archived", status: "archived", priority: "critical" },
					{ id: 5, title: "Subissue", status: "open",     priority: "low", parent_id: 1 },
				],
				comments: [
					{ id: 1, issue_id: 1, content: "hi", kind: "note" },
				],
				dependencies: [
					{ blocker_id: 2, blocked_id: 3 },
				],
				agent: { agent_id: "imported" },
			});
			try {
				// Mirror the importer's main() body without spawning a subprocess.
				const sqlite = await import("better-sqlite3");
				const Database = sqlite.default;
				const db = new Database(fx.dbPath, { readonly: true });
				const issues = db.prepare(`SELECT id, title, description, status, priority, parent_id, created_at, updated_at, closed_at FROM issues ORDER BY id`).all() as ChainlinkIssue[];
				const comments = db.prepare(`SELECT id, issue_id, content, created_at, kind FROM comments ORDER BY id`).all() as ChainlinkComment[];
				const deps = db.prepare(`SELECT blocker_id, blocked_id FROM dependencies`).all() as ChainlinkDep[];
				db.close();

				await client.query("BEGIN");
				const map = await migrateIssues(client, issues);
				await migrateComments(client, comments, map);
				await migrateDeps(client, deps);
				await migrateAgentJson(client, fx.agentJsonPath);
				await assertNoCycles(client);
				await client.query("COMMIT");

				const phaseRows = await client.query<{ id: string; phase: Phase }>(`SELECT id, phase FROM issues ORDER BY id`);
				const byId = new Map(phaseRows.rows.map((r) => [Number(r.id), r.phase]));
				expect(byId.get(1)).toBe("ready");
				expect(byId.get(2)).toBe("drafting");
				expect(byId.get(3)).toBe("done");
				expect(byId.get(4)).toBe("archived");
				expect(byId.get(5)).toBe("ready");

				const cmt = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM comments`);
				expect(Number(cmt.rows[0].n)).toBe(1);

				const dep = await client.query<{ blocker_id: string; blocked_id: string }>(
					`SELECT blocker_id, blocked_id FROM dependencies ORDER BY blocker_id, blocked_id`,
				);
				const edges = dep.rows.map((r) => [Number(r.blocker_id), Number(r.blocked_id)]);
				expect(edges).toContainEqual([2, 3]);   // from dependencies table
				expect(edges).toContainEqual([5, 1]);   // from parent_id conversion

				const agent = await client.query<{ agent_id: string }>(`SELECT agent_id FROM agent_config`);
				expect(agent.rows[0].agent_id).toBe("imported");
			} finally {
				fx.dispose();
			}
		});
	});
});

// configureDb-dependent helper — issueCreate uses the module-level pool.
describe.skipIf(!isPostgresAvailable())("issueCreate after import respects sequence reset", () => {
	const handle = useTempDb();

	beforeEach(async () => {
		await truncateAll();
		configureDb({ databaseUrl: handle.url(), agentId: "test", staleLockTimeoutMinutes: 60 });
	});

	it("issues_id_seq advances past imported ids", async () => {
		const client = new Client({ connectionString: handle.url() });
		await client.connect();
		try {
			const rows: ChainlinkIssue[] = [
				{ id: 100, title: "T100", description: null, status: "open", priority: "low", parent_id: null, created_at: "2024-01-01", updated_at: "2024-01-01", closed_at: null },
			];
			await client.query("BEGIN");
			await migrateIssues(client, rows);
			await client.query("COMMIT");
		} finally {
			await client.end();
		}

		const next = await issueCreate({} as never, { title: "after", priority: "low" });
		expect(next).toBeGreaterThan(100);

		// Use getPool just to confirm we're on the same DB.
		expect(getPool()).toBeDefined();
	});
});
