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

import { describe, expect, it } from "vitest";
import type { Phase, PhaseEvent } from "../agent/extensions/bogstandard/db.js";
import {
	IDLE_STATE,
	isActive,
	isMidWorkPhase,
	reconstructFromEvents,
} from "../agent/extensions/bogstandard/phases.js";

let nextId = 1000;

function ev(
	phaseTo: Phase,
	overrides: Partial<PhaseEvent> = {},
): PhaseEvent {
	return {
		id: nextId--,
		issue_id: 1,
		version_id: 1,
		phase_from: null,
		phase_to: phaseTo,
		agent_id: null,
		reason: null,
		metadata: null,
		created_at: new Date().toISOString(),
		...overrides,
	};
}

describe("isMidWorkPhase", () => {
	it.each<Phase>(["planning", "implementing", "red_planning", "red_impl", "green_planning", "green_impl"])(
		"%s is mid-work",
		(p) => {
			expect(isMidWorkPhase(p)).toBe(true);
		},
	);

	it.each<Phase>(["drafting", "ready", "done", "aborted", "archived"])(
		"%s is not mid-work",
		(p) => {
			expect(isMidWorkPhase(p)).toBe(false);
		},
	);

	it("undefined is not mid-work", () => {
		expect(isMidWorkPhase(undefined)).toBe(false);
	});
});

describe("isActive", () => {
	it("idle state is not active", () => {
		expect(isActive(IDLE_STATE)).toBe(false);
	});

	it("state with issueId + planning phase is active", () => {
		expect(isActive({ ...IDLE_STATE, issueId: 1, phase: "planning" })).toBe(true);
	});

	it("done is not active", () => {
		expect(isActive({ ...IDLE_STATE, issueId: 1, phase: "done" })).toBe(false);
	});

	it("aborted is not active", () => {
		expect(isActive({ ...IDLE_STATE, issueId: 1, phase: "aborted" })).toBe(false);
	});
});

describe("reconstructFromEvents", () => {
	it("returns base state when there are no events", () => {
		const state = reconstructFromEvents("planning", 1, 5, []);
		expect(state.issueId).toBe(1);
		expect(state.phase).toBe("planning");
		expect(state.versionId).toBe(5);
		expect(state.plan).toBeUndefined();
		expect(state.redDiff).toBeUndefined();
	});

	it("restores plan from the most recent transition-into-implementing event", () => {
		const events: PhaseEvent[] = [
			ev("implementing", { metadata: { plan: "my plan" } }),
		];
		const state = reconstructFromEvents("implementing", 1, 5, events);
		expect(state.plan).toBe("my plan");
	});

	it("restores plan for red_impl from a transition-into-red_impl event", () => {
		const events: PhaseEvent[] = [ev("red_impl", { metadata: { plan: "red plan" } })];
		const state = reconstructFromEvents("red_impl", 1, 5, events);
		expect(state.plan).toBe("red plan");
	});

	it("restores plan + redDiff for green_impl", () => {
		const events: PhaseEvent[] = [
			ev("green_impl", { metadata: { plan: "green plan" } }),
			ev("green_planning", { metadata: { red_sha: "abc1234", red_diff: "diff body" } }),
		];
		const state = reconstructFromEvents("green_impl", 1, 5, events);
		expect(state.plan).toBe("green plan");
		expect(state.redDiff).toBe("diff body");
	});

	it("captures bail_sha when current phase is red_planning", () => {
		const events: PhaseEvent[] = [
			ev("red_planning", { metadata: { bail_sha: "deadbeef", reason: "bail" } }),
		];
		const state = reconstructFromEvents("red_planning", 1, 5, events);
		expect(state.bailRedSha).toBe("deadbeef");
	});

	it("does not pick up bail_sha when current phase is not red_planning", () => {
		const events: PhaseEvent[] = [
			ev("red_planning", { metadata: { bail_sha: "deadbeef" } }),
		];
		const state = reconstructFromEvents("planning", 1, 5, events);
		expect(state.bailRedSha).toBeUndefined();
	});

	it("does not restore plan from an event for a different phase", () => {
		const events: PhaseEvent[] = [
			ev("red_impl", { metadata: { plan: "red plan, not for green" } }),
		];
		const state = reconstructFromEvents("green_impl", 1, 5, events);
		expect(state.plan).toBeUndefined();
	});
});
