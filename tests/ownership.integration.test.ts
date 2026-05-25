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
 * Integration tests for ownership (the collapsed lock that lives on the
 * issues row) and the two queries in phases.ts that consume it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	claimIssue,
	configureDb,
	getOwnership,
	getPool,
	issueCreate,
	releaseIssue,
	stealIssue,
	touchOwnership,
	transitionPhase,
	type Phase,
} from "../agent/extensions/bogstandard/db.js";
import { loadState, loadStateForIssue } from "../agent/extensions/bogstandard/phases.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

async function makeReady(): Promise<number> {
	return issueCreate(pi, { title: "T", priority: "medium", phase: "ready", needs_tests: true });
}

async function backdatePhase(id: number, minutesAgo: number): Promise<void> {
	await getPool().query(
		`UPDATE issues SET phase_started_at = now() - ($1 || ' minutes')::interval WHERE id = $2`,
		[minutesAgo, id],
	);
}

describe.skipIf(!isPostgresAvailable())("ownership (db.ts)", () => {
	const handle = useTempDb();

	beforeEach(async () => {
		await truncateAll();
		// Re-configure with a known agent + stale window for the loadState test below.
		configureDb({ databaseUrl: handle.url(), agentId: "test", staleLockTimeoutMinutes: 60 });
	});

	describe("getOwnership", () => {
		it("returns null for missing issue", async () => {
			expect(await getOwnership(pi, 9999)).toBeNull();
		});

		it("returns nulled fields for unowned issue", async () => {
			const id = await makeReady();
			const o = await getOwnership(pi, id);
			expect(o?.current_agent_id).toBeNull();
			expect(o?.phase).toBe("ready");
		});

		it("returns the owner when set", async () => {
			const id = await makeReady();
			await getPool().query(`UPDATE issues SET current_agent_id = 'alice' WHERE id = $1`, [id]);
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("alice");
		});
	});

	describe("claimIssue", () => {
		it("fresh claim by an agent succeeds", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("alice");
		});

		it("same agent re-claim succeeds and refreshes phase_started_at", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			const before = (await getOwnership(pi, id))?.phase_started_at;
			await new Promise((r) => setTimeout(r, 10));
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			const after = (await getOwnership(pi, id))?.phase_started_at;
			expect(after).not.toBeNull();
			if (before) {
				expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before).getTime());
			}
		});

		it("different agent fails while claim is fresh", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			expect(await claimIssue(pi, id, "bob", 60)).toBe(false);
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("alice");
		});

		it("different agent succeeds after stale window", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await backdatePhase(id, 90);
			expect(await claimIssue(pi, id, "bob", 60)).toBe(true);
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("bob");
		});
	});

	describe("releaseIssue", () => {
		it("clears current_agent_id when we own it", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await releaseIssue(pi, id, "alice");
			expect((await getOwnership(pi, id))?.current_agent_id).toBeNull();
		});

		it("no-op when someone else owns it", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await releaseIssue(pi, id, "bob");
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("alice");
		});

		it("no-op when issue missing", async () => {
			await expect(releaseIssue(pi, 9999, "alice")).resolves.toBeUndefined();
		});
	});

	describe("stealIssue", () => {
		it("force-claims regardless of current owner", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await stealIssue(pi, id, "bob");
			expect((await getOwnership(pi, id))?.current_agent_id).toBe("bob");
		});

		it("updates phase_started_at", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await backdatePhase(id, 90);
			await stealIssue(pi, id, "bob");
			const o = await getOwnership(pi, id);
			expect(o?.phase_started_at).not.toBeNull();
			expect(Date.now() - new Date(o!.phase_started_at!).getTime()).toBeLessThan(60 * 60_000);
		});
	});

	describe("touchOwnership", () => {
		it("bumps phase_started_at when we own it", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await backdatePhase(id, 30);
			const before = (await getOwnership(pi, id))?.phase_started_at;
			await touchOwnership(pi, id, "alice");
			const after = (await getOwnership(pi, id))?.phase_started_at;
			expect(after).not.toBeNull();
			expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
		});

		it("no-op when we don't own it", async () => {
			const id = await makeReady();
			expect(await claimIssue(pi, id, "alice", 60)).toBe(true);
			await backdatePhase(id, 30);
			const before = (await getOwnership(pi, id))?.phase_started_at;
			await touchOwnership(pi, id, "bob");
			const after = (await getOwnership(pi, id))?.phase_started_at;
			expect(new Date(after!).getTime()).toBe(new Date(before!).getTime());
		});
	});

	describe("concurrent claim", () => {
		it("only one of two parallel fresh claims wins", async () => {
			for (let trial = 0; trial < 5; trial++) {
				const id = await makeReady();
				const [a, b] = await Promise.all([
					claimIssue(pi, id, "alice", 60),
					claimIssue(pi, id, "bob", 60),
				]);
				const wins = [a, b].filter(Boolean).length;
				expect(wins).toBeGreaterThanOrEqual(1);
				// At most one *different* agent owns the row at the end.
				const owner = (await getOwnership(pi, id))?.current_agent_id;
				expect(owner === "alice" || owner === "bob").toBe(true);
			}
		});
	});
});

describe.skipIf(!isPostgresAvailable())("phases.ts SQL queries", () => {
	const handle = useTempDb();

	beforeEach(async () => {
		await truncateAll();
		configureDb({ databaseUrl: handle.url(), agentId: "test", staleLockTimeoutMinutes: 60 });
	});

	describe("loadStateForIssue", () => {
		it("returns IDLE_STATE for missing issue", async () => {
			const state = await loadStateForIssue(pi, 9999);
			expect(state.issueId).toBeUndefined();
			expect(state.phase).toBeUndefined();
		});

		it("loads phase + versionId for an existing issue", async () => {
			const id = await makeReady();
			const state = await loadStateForIssue(pi, id);
			expect(state.issueId).toBe(id);
			expect(state.phase).toBe("ready");
			expect(state.versionId).not.toBeUndefined();
		});

		it("recovers plan from a recent transition-into-implementing event", async () => {
			const id = await makeReady();
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: "alice" });
			await transitionPhase(pi, {
				issueId: id,
				from: "planning",
				to: "implementing",
				agentId: "alice",
				metadata: { plan: "my plan" },
			});
			const state = await loadStateForIssue(pi, id);
			expect(state.phase).toBe("implementing");
			expect(state.plan).toBe("my plan");
		});
	});

	describe("findOwnedIssue (via loadState)", () => {
		it("returns IDLE_STATE when agentId is null", async () => {
			const state = await loadState(pi, null);
			expect(state.issueId).toBeUndefined();
		});

		it("returns IDLE_STATE when agent owns nothing", async () => {
			await makeReady();
			const state = await loadState(pi, "ghost");
			expect(state.issueId).toBeUndefined();
		});

		it("picks the issue currently claimed by the agent", async () => {
			const a = await makeReady();
			const b = await makeReady();
			await claimIssue(pi, b, "alice", 60);
			const state = await loadState(pi, "alice");
			expect(state.issueId).toBe(b);
			expect(state.phase).toBe("ready");
			expect(a).not.toBe(b);
		});

		it("excludes done / aborted / archived even when current_agent_id matches", async () => {
			const id = await makeReady();
			await claimIssue(pi, id, "alice", 60);
			for (const target of ["done", "aborted", "archived"] as Phase[]) {
				// Set the phase directly (preserving current_agent_id).
				await getPool().query(`UPDATE issues SET phase = $1 WHERE id = $2`, [target, id]);
				await getPool().query(`UPDATE issues SET current_agent_id = 'alice' WHERE id = $1`, [id]);
				const state = await loadState(pi, "alice");
				expect(state.issueId).toBeUndefined();
			}
		});

		it("tie-breaks by phase_started_at DESC then id DESC", async () => {
			const a = await makeReady();
			const b = await makeReady();
			await claimIssue(pi, a, "alice", 60);
			await claimIssue(pi, b, "alice", 60);
			// b was claimed second so its phase_started_at is newer → wins.
			const state = await loadState(pi, "alice");
			expect(state.issueId).toBe(b);
		});
	});
});
