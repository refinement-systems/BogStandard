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
 * Integration tests for `transitionPhase` and `appendPhaseEvent`.
 *
 * `transitionPhase` is the heart of the state machine: it gates the UPDATE
 * on a caller-supplied `from` to prevent concurrent races, clears
 * current_agent_id when entering non-working phases, and writes a
 * phase_events row atomically with the issue update.
 *
 * `appendPhaseEvent` writes a phase_events row WITHOUT touching the issues
 * row — used for heartbeat-style markers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendPhaseEvent,
	getPool,
	issueCreate,
	recentPhaseEvents,
	transitionPhase,
} from "../agent/extensions/bogstandard/db.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

async function makeReady(): Promise<number> {
	return issueCreate(pi, { title: "T", priority: "medium", phase: "ready", needs_tests: true });
}

async function readPhase(id: number): Promise<{
	phase: string;
	current_agent_id: string | null;
	phase_started_at: Date | null;
}> {
	const res = await getPool().query<{
		phase: string;
		current_agent_id: string | null;
		phase_started_at: Date | null;
	}>(
		`SELECT phase, current_agent_id, phase_started_at FROM issues WHERE id = $1`,
		[id],
	);
	return res.rows[0];
}

describe.skipIf(!isPostgresAvailable())("transitionPhase", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	describe("from precondition", () => {
		it("succeeds when from matches", async () => {
			const id = await makeReady();
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: "alice" });
			expect((await readPhase(id)).phase).toBe("planning");
		});

		it("throws when from is stale", async () => {
			const id = await makeReady();
			await expect(
				transitionPhase(pi, { issueId: id, from: "planning", to: "implementing", agentId: "alice" }),
			).rejects.toThrow(/precondition failed/);
			// Phase unchanged.
			expect((await readPhase(id)).phase).toBe("ready");
		});

		it("with no from succeeds even if caller is unsure of current phase", async () => {
			const id = await makeReady();
			await transitionPhase(pi, { issueId: id, to: "done", agentId: null });
			expect((await readPhase(id)).phase).toBe("done");
		});
	});

	describe("current_agent_id handling", () => {
		it("preserves current_agent_id when transitioning into a working phase", async () => {
			const id = await makeReady();
			await getPool().query(`UPDATE issues SET current_agent_id = 'alice' WHERE id = $1`, [id]);
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: "alice" });
			expect((await readPhase(id)).current_agent_id).toBe("alice");
		});

		it.each(["done", "aborted", "archived", "ready", "drafting"])(
			"clears current_agent_id when entering non-working phase '%s'",
			async (target) => {
				const id = await makeReady();
				await getPool().query(`UPDATE issues SET current_agent_id = 'alice' WHERE id = $1`, [id]);
				await transitionPhase(pi, {
					issueId: id,
					to: target as Parameters<typeof transitionPhase>[1]["to"],
					agentId: "alice",
				});
				expect((await readPhase(id)).current_agent_id).toBeNull();
			},
		);
	});

	describe("phase_started_at reset", () => {
		it("resets phase_started_at on every transition", async () => {
			const id = await makeReady();
			const before = (await readPhase(id)).phase_started_at;
			await new Promise((r) => setTimeout(r, 5));
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: "alice" });
			const after = (await readPhase(id)).phase_started_at;
			expect(after).not.toBeNull();
			if (before === null) {
				// fine — first reset
				return;
			}
			expect(after!.getTime()).toBeGreaterThan(before.getTime());
		});
	});

	describe("versionId auto-lookup", () => {
		it("uses current_version_id when versionId omitted", async () => {
			const id = await makeReady();
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: null });
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].version_id).not.toBeNull();
		});

		it("respects explicit versionId override", async () => {
			const id = await makeReady();
			// Insert a v2 row but don't flip the pointer.
			const v2 = await getPool().query<{ id: string }>(
				`INSERT INTO issue_versions (issue_id, version_no, title) VALUES ($1, 2, 'X') RETURNING id`,
				[id],
			);
			const v2Id = Number(v2.rows[0].id);
			await transitionPhase(pi, {
				issueId: id,
				from: "ready",
				to: "planning",
				agentId: null,
				versionId: v2Id,
			});
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].version_id).toBe(v2Id);
		});

		it("respects explicit versionId=null override", async () => {
			const id = await makeReady();
			await transitionPhase(pi, {
				issueId: id,
				from: "ready",
				to: "planning",
				agentId: null,
				versionId: null,
			});
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].version_id).toBeNull();
		});

		it("throws on missing issue when version auto-lookup fails", async () => {
			await expect(
				transitionPhase(pi, { issueId: 9999, from: "ready", to: "planning", agentId: null }),
			).rejects.toThrow(/Issue 9999 not found/);
		});
	});

	describe("metadata + reason round-trip", () => {
		it("serializes metadata to JSON and round-trips byte-for-byte", async () => {
			const id = await makeReady();
			const metadata = { plan: "test plan", nested: { count: 3, arr: [1, 2, 3] } };
			await transitionPhase(pi, {
				issueId: id,
				from: "ready",
				to: "planning",
				agentId: "alice",
				reason: "test reason",
				metadata,
			});
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].metadata).toEqual(metadata);
			expect(events[0].reason).toBe("test reason");
			expect(events[0].phase_from).toBe("ready");
			expect(events[0].phase_to).toBe("planning");
			expect(events[0].agent_id).toBe("alice");
		});

		it("null metadata stays null in the row", async () => {
			const id = await makeReady();
			await transitionPhase(pi, { issueId: id, from: "ready", to: "planning", agentId: null });
			const events = await recentPhaseEvents(pi, id, 1);
			expect(events[0].metadata).toBeNull();
		});
	});

	describe("atomicity", () => {
		it("rollback when the phase_events insert fails leaves issues.phase unchanged", async () => {
			const id = await makeReady();
			// Add a CHECK on phase_events.reason that blocks our specific reason.
			await getPool().query(
				`ALTER TABLE phase_events ADD CONSTRAINT pe_no_test CHECK (reason <> 'forbidden')`,
			);
			try {
				await expect(
					transitionPhase(pi, {
						issueId: id,
						from: "ready",
						to: "planning",
						agentId: null,
						reason: "forbidden",
					}),
				).rejects.toThrow();
			} finally {
				await getPool().query(`ALTER TABLE phase_events DROP CONSTRAINT pe_no_test`);
			}
			expect((await readPhase(id)).phase).toBe("ready");
		});
	});
});

describe.skipIf(!isPostgresAvailable())("appendPhaseEvent", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	it("writes a row with phase_from = phase_to = $3", async () => {
		const id = await makeReady();
		await appendPhaseEvent(pi, { issueId: id, phase: "ready", agentId: "alice", reason: "heartbeat" });
		const events = await recentPhaseEvents(pi, id, 1);
		expect(events[0].phase_from).toBe("ready");
		expect(events[0].phase_to).toBe("ready");
		expect(events[0].reason).toBe("heartbeat");
		expect(events[0].agent_id).toBe("alice");
	});

	it("does not change the issue's phase or phase_started_at", async () => {
		const id = await makeReady();
		const before = await readPhase(id);
		await new Promise((r) => setTimeout(r, 10));
		await appendPhaseEvent(pi, { issueId: id, phase: "ready", agentId: null });
		const after = await readPhase(id);
		expect(after.phase).toBe(before.phase);
		expect(after.phase_started_at).toEqual(before.phase_started_at);
	});

	it("auto-looks-up versionId when omitted", async () => {
		const id = await makeReady();
		await appendPhaseEvent(pi, { issueId: id, phase: "ready", agentId: null });
		const events = await recentPhaseEvents(pi, id, 1);
		expect(events[0].version_id).not.toBeNull();
	});

	it("throws when issue missing and versionId omitted", async () => {
		await expect(
			appendPhaseEvent(pi, { issueId: 9999, phase: "ready", agentId: null }),
		).rejects.toThrow(/Issue 9999 not found/);
	});

	it("metadata round-trips", async () => {
		const id = await makeReady();
		await appendPhaseEvent(pi, {
			issueId: id,
			phase: "ready",
			agentId: null,
			metadata: { k: "v" },
		});
		const events = await recentPhaseEvents(pi, id, 1);
		expect(events[0].metadata).toEqual({ k: "v" });
	});
});
