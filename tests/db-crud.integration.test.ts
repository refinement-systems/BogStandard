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
 * Integration tests for the CRUD surface of db.ts that isn't part of the
 * phase machine or ownership. Phase transitions, ownership, and redraft each
 * get their own file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getPool,
	issueArchive,
	issueComment,
	issueCreate,
	issueList,
	issueListFiltered,
	issuePromoteToReady,
	issueShowJson,
	issueUpdate,
	recentPhaseEvents,
	transitionPhase,
} from "../agent/extensions/bogstandard/db.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

describe.skipIf(!isPostgresAvailable())("db.ts CRUD", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	describe("issueList", () => {
		it("returns an empty array on an empty database", async () => {
			expect(await issueList(pi)).toEqual([]);
		});

		it("orders by id and exposes phase + priority + status alias", async () => {
			const a = await issueCreate(pi, { title: "A", priority: "high", phase: "ready" });
			const b = await issueCreate(pi, { title: "B", priority: "low" });
			const list = await issueList(pi);
			expect(list.map((r) => r.id)).toEqual([a, b]);
			expect(list[0]).toMatchObject({ id: a, title: "A", phase: "ready", priority: "high", status: "ready" });
			expect(list[1]).toMatchObject({ id: b, title: "B", phase: "drafting", priority: "low", status: "drafting" });
		});

		it("excludes issues with current_version_id IS NULL (mid-insert state)", async () => {
			const a = await issueCreate(pi, { title: "A", priority: "medium" });
			await getPool().query(`UPDATE issues SET current_version_id = NULL WHERE id = $1`, [a]);
			expect(await issueList(pi)).toEqual([]);
		});
	});

	describe("issueShowJson", () => {
		it("throws on missing id", async () => {
			await expect(issueShowJson(pi, 9999)).rejects.toThrow(/Issue 9999 not found/);
		});

		it("returns the current version with phase, priority, and blockers", async () => {
			const id = await issueCreate(pi, {
				title: "Title",
				description: "Body",
				priority: "high",
				needs_tests: true,
			});
			const detail = await issueShowJson(pi, id);
			expect(detail).toMatchObject({
				id,
				title: "Title",
				description: "Body",
				phase: "drafting",
				priority: "high",
				needs_tests: true,
				current_version_no: 1,
				comments: [],
				blocked_by: [],
			});
		});

		it("comments are scoped to the current version only", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium", needs_tests: false });
			await issueComment(pi, id, "note", "v1-comment");
			// Manually advance to v2 to simulate redraft without going through redraftIssue.
			const v2 = await getPool().query<{ id: string }>(
				`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests)
				      VALUES ($1, 2, 'T', 'D', true) RETURNING id`,
				[id],
			);
			await getPool().query(
				`UPDATE issues SET current_version_id = $1 WHERE id = $2`,
				[Number(v2.rows[0].id), id],
			);
			await issueComment(pi, id, "note", "v2-comment");

			const detail = await issueShowJson(pi, id);
			expect(detail.current_version_no).toBe(2);
			expect((detail.comments ?? []).map((c) => c.content)).toEqual(["v2-comment"]);
		});

		it("include_history bundles all versions and groups comments per version", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium", needs_tests: false });
			await issueComment(pi, id, "note", "v1-comment");
			const v2 = await getPool().query<{ id: string }>(
				`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests)
				      VALUES ($1, 2, 'T2', 'D2', true) RETURNING id`,
				[id],
			);
			await getPool().query(
				`UPDATE issues SET current_version_id = $1 WHERE id = $2`,
				[Number(v2.rows[0].id), id],
			);
			await issueComment(pi, id, "note", "v2-comment");

			const detail = await issueShowJson(pi, id, { include_history: true });
			expect(detail.history).toHaveLength(2);
			expect(detail.history?.[0].version_no).toBe(1);
			expect(detail.history?.[0].comments.map((c) => c.content)).toEqual(["v1-comment"]);
			expect(detail.history?.[1].version_no).toBe(2);
			expect(detail.history?.[1].comments.map((c) => c.content)).toEqual(["v2-comment"]);
		});

		it("blocked_by lists all blocker ids in ascending order", async () => {
			const blocker1 = await issueCreate(pi, { title: "B1", priority: "low" });
			const blocker2 = await issueCreate(pi, { title: "B2", priority: "low" });
			const blocked = await issueCreate(pi, { title: "X", priority: "low" });
			await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [blocker2, blocked]);
			await getPool().query(`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`, [blocker1, blocked]);
			const detail = await issueShowJson(pi, blocked);
			expect(detail.blocked_by).toEqual([blocker1, blocker2]);
		});
	});

	describe("issueComment", () => {
		it("throws on missing id", async () => {
			await expect(issueComment(pi, 9999, "note", "x")).rejects.toThrow(/Issue 9999 not found/);
		});

		it("attaches the comment to the current version", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await issueComment(pi, id, "note", "hello");
			const detail = await issueShowJson(pi, id);
			expect((detail.comments ?? []).map((c) => ({ kind: c.kind, content: c.content }))).toEqual([
				{ kind: "note", content: "hello" },
			]);
		});
	});

	describe("issueCreate", () => {
		it("rejects an empty title", async () => {
			await expect(
				issueCreate(pi, { title: "  ", priority: "medium" }),
			).rejects.toThrow(/title must not be empty/);
		});

		it("rejects an invalid priority", async () => {
			await expect(
				issueCreate(pi, { title: "Ok", priority: "urgent" }),
			).rejects.toThrow(/Invalid priority/);
		});

		it("defaults phase to 'drafting'", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium" });
			expect((await issueShowJson(pi, id)).phase).toBe("drafting");
		});

		it("accepts an explicit phase", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium", phase: "ready" });
			expect((await issueShowJson(pi, id)).phase).toBe("ready");
		});

		it("sets current_version_id on the new row", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium" });
			const row = await getPool().query<{ current_version_id: string | null }>(
				`SELECT current_version_id FROM issues WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].current_version_id).not.toBeNull();
		});

		it("records needs_tests on the v1 row when provided", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium", needs_tests: true });
			expect((await issueShowJson(pi, id)).needs_tests).toBe(true);
		});

		it("records created_by on the v1 row when provided", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "medium", created_by: "alice" });
			const row = await getPool().query<{ created_by: string | null }>(
				`SELECT created_by FROM issue_versions WHERE issue_id = $1 AND version_no = 1`,
				[id],
			);
			expect(row.rows[0].created_by).toBe("alice");
		});
	});

	describe("issueUpdate", () => {
		it("no-op when no fields are passed", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			const before = await issueShowJson(pi, id);
			await issueUpdate(pi, id, {});
			const after = await issueShowJson(pi, id);
			expect(after.title).toBe(before.title);
		});

		it("throws on missing id when any field is passed", async () => {
			await expect(issueUpdate(pi, 9999, { priority: "high" })).rejects.toThrow(/Issue 9999 not found/);
		});

		it("updates priority during any phase", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: false });
			await issueUpdate(pi, id, { priority: "critical" });
			expect((await issueShowJson(pi, id)).priority).toBe("critical");
		});

		it("rejects an invalid priority and rolls back", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(issueUpdate(pi, id, { priority: "urgent" })).rejects.toThrow(/Invalid priority/);
		});

		it("updates title/description/needs_tests during drafting", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await issueUpdate(pi, id, { title: "T2", description: "D", needs_tests: true });
			const after = await issueShowJson(pi, id);
			expect(after.title).toBe("T2");
			expect(after.description).toBe("D");
			expect(after.needs_tests).toBe(true);
		});

		it("rejects title/description/needs_tests edits outside drafting", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: false });
			await expect(issueUpdate(pi, id, { description: "X" })).rejects.toThrow(/can only be edited while drafting/);
			// Verify rollback: description unchanged.
			expect((await issueShowJson(pi, id)).description ?? "").toBe("");
		});

		it("rejects empty title and rolls back", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(issueUpdate(pi, id, { title: "  " })).rejects.toThrow(/title must not be empty/);
			expect((await issueShowJson(pi, id)).title).toBe("T");
		});

		it("bumps updated_at on a priority-only update", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			const before = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM issues WHERE id = $1`, [id]);
			await new Promise((r) => setTimeout(r, 5));
			await issueUpdate(pi, id, { priority: "high" });
			const after = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM issues WHERE id = $1`, [id]);
			expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
		});

		it("bumps updated_at on a version-only update during drafting", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			const before = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM issues WHERE id = $1`, [id]);
			await new Promise((r) => setTimeout(r, 5));
			await issueUpdate(pi, id, { title: "T2" });
			const after = await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM issues WHERE id = $1`, [id]);
			expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
		});
	});

	describe("issueArchive", () => {
		it("transitions the issue to 'archived' and writes a phase_events row with prior phase as phase_from", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready" });
			await issueArchive(pi, id, "alice");
			expect((await issueShowJson(pi, id)).phase).toBe("archived");
			const events = await recentPhaseEvents(pi, id, 10);
			expect(events[0].phase_to).toBe("archived");
			expect(events[0].phase_from).toBe("ready");
			expect(events[0].agent_id).toBe("alice");
		});

		it("is a silent no-op when already archived", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready" });
			await issueArchive(pi, id, "alice");
			const eventsBefore = await recentPhaseEvents(pi, id, 10);
			await issueArchive(pi, id, "alice");
			const eventsAfter = await recentPhaseEvents(pi, id, 10);
			expect(eventsAfter.length).toBe(eventsBefore.length);
		});

		it("throws on missing id", async () => {
			await expect(issueArchive(pi, 9999, "alice")).rejects.toThrow(/Issue 9999 not found/);
		});
	});

	describe("issuePromoteToReady", () => {
		it("rejects when phase != 'drafting'", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: true });
			await expect(issuePromoteToReady(pi, id, "alice")).rejects.toThrow(/cannot promote to ready/);
		});

		it("rejects when needs_tests is NULL", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low" });
			await expect(issuePromoteToReady(pi, id, "alice")).rejects.toThrow(/needs_tests is not set/);
		});

		it("transitions to 'ready' and writes the phase_events row", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", needs_tests: true });
			await issuePromoteToReady(pi, id, "alice");
			expect((await issueShowJson(pi, id)).phase).toBe("ready");
			const events = await recentPhaseEvents(pi, id, 10);
			expect(events[0]).toMatchObject({ phase_from: "drafting", phase_to: "ready", agent_id: "alice" });
		});

		it("throws on missing id", async () => {
			await expect(issuePromoteToReady(pi, 9999, "alice")).rejects.toThrow(/Issue 9999 not found/);
		});

		it("a second promotion call (after the first succeeded) sees phase='ready' and rejects", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", needs_tests: true });
			await issuePromoteToReady(pi, id, "alice");
			await expect(issuePromoteToReady(pi, id, "bob")).rejects.toThrow(/cannot promote to ready/);
		});
	});

	describe("issueListFiltered", () => {
		async function seed(): Promise<{ d: number; r: number; ra: number; done: number }> {
			const d = await issueCreate(pi, { title: "D", priority: "low" });
			const r = await issueCreate(pi, { title: "R", priority: "high", phase: "ready", needs_tests: true });
			const ra = await issueCreate(pi, { title: "RA", priority: "low", phase: "ready", needs_tests: true });
			const done = await issueCreate(pi, { title: "Z", priority: "medium", phase: "ready", needs_tests: true });
			await transitionPhase(pi, { issueId: done, from: "ready", to: "done", agentId: null });
			return { d, r, ra, done };
		}

		it("default filter returns drafting + ready", async () => {
			const { d, r, ra } = await seed();
			const ids = (await issueListFiltered(pi)).map((i) => i.id).sort((a, b) => a - b);
			expect(ids).toEqual([d, r, ra].sort((a, b) => a - b));
		});

		it("explicit scalar phase filter", async () => {
			const { d } = await seed();
			const ids = (await issueListFiltered(pi, { phase: "drafting" })).map((i) => i.id);
			expect(ids).toEqual([d]);
		});

		it("explicit array phase filter", async () => {
			const { r, ra, done } = await seed();
			const ids = (await issueListFiltered(pi, { phase: ["ready", "done"] })).map((i) => i.id).sort((a, b) => a - b);
			expect(ids).toEqual([r, ra, done].sort((a, b) => a - b));
		});

		it("priority filter", async () => {
			const { r } = await seed();
			const ids = (await issueListFiltered(pi, { priority: "high" })).map((i) => i.id);
			expect(ids).toEqual([r]);
		});

		it("phase array + priority combined", async () => {
			const { r } = await seed();
			const ids = (await issueListFiltered(pi, { phase: ["ready"], priority: "high" })).map((i) => i.id);
			expect(ids).toEqual([r]);
		});
	});

	describe("recentPhaseEvents", () => {
		it("returns DESC by id and respects limit", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: true });
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: "alice" });
			await transitionPhase(pi, { issueId: id, from: "planning", to: "implementing", agentId: "alice" });
			await transitionPhase(pi, { issueId: id, from: "implementing", to: "done", agentId: "alice" });

			const all = await recentPhaseEvents(pi, id, 100);
			// Newest first: done, implementing, planning.
			expect(all.map((e) => e.phase_to)).toEqual(["done", "implementing", "planning"]);

			const limited = await recentPhaseEvents(pi, id, 1);
			expect(limited).toHaveLength(1);
			expect(limited[0].phase_to).toBe("done");
		});

		it("metadata JSON round-trips byte-for-byte", async () => {
			const id = await issueCreate(pi, { title: "T", priority: "low", phase: "ready", needs_tests: true });
			await transitionPhase(pi, {
				issueId: id,
				from: "ready",
				to: "planning",
				agentId: "alice",
				metadata: { plan: "do the thing", nested: { count: 42 } },
			});
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].metadata).toEqual({ plan: "do the thing", nested: { count: 42 } });
		});
	});
});
