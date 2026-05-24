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
import { IDLE_STATE, endReason } from "../agent/extensions/bogstandard/phases.js";
import type { BogstandardState } from "../agent/extensions/bogstandard/phases.js";

function makeEvent(stopReason?: string) {
	const lastMsg = stopReason !== undefined ? { role: "assistant", stopReason } : { role: "assistant" };
	return { messages: [lastMsg] };
}

function makeState(overrides: Partial<BogstandardState> = {}): BogstandardState {
	return { ...IDLE_STATE, issueId: 1, versionId: 1, phase: "implementing", ...overrides };
}

describe("endReason", () => {
	it("returns completed on natural stop during implementing", () => {
		expect(endReason(makeEvent("stop"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed on natural stop during green_impl", () => {
		expect(endReason(makeEvent("stop"), makeState({ phase: "green_impl" }))).toBe("completed");
	});

	it("returns tool-terminate when planning + plan is set (save_plan path)", () => {
		expect(
			endReason(makeEvent("aborted"), makeState({ phase: "planning", plan: "p" })),
		).toBe("tool-terminate");
	});

	it("returns tool-terminate for red_planning with plan set", () => {
		expect(
			endReason(makeEvent("aborted"), makeState({ phase: "red_planning", plan: "p" })),
		).toBe("tool-terminate");
	});

	it("returns tool-terminate for green_planning with plan set", () => {
		expect(
			endReason(makeEvent("aborted"), makeState({ phase: "green_planning", plan: "p" })),
		).toBe("tool-terminate");
	});

	it("returns tool-terminate when green_impl + bailReason is set (bail_out path)", () => {
		expect(
			endReason(
				makeEvent("aborted"),
				makeState({ phase: "green_impl", bailReason: "impossible" }),
			),
		).toBe("tool-terminate");
	});

	it("returns tool-terminate when redraftDiagnosis is set (propose_redraft path)", () => {
		expect(
			endReason(
				makeEvent("stop"),
				makeState({ phase: "planning", redraftDiagnosis: "design is wrong" }),
			),
		).toBe("tool-terminate");
	});

	it("returns interrupted on aborted during implementing", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "implementing" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during red_impl", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "red_impl" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during green_impl without bailReason", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "green_impl" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during planning (no plan yet)", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "planning" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during red_planning (no plan yet)", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "red_planning" }))).toBe("interrupted");
	});

	it("returns completed when messages array is empty", () => {
		expect(endReason({ messages: [] }, makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed for stopReason length", () => {
		expect(endReason(makeEvent("length"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("bail_out during green_impl without aborted stopReason is still tool-terminate", () => {
		expect(
			endReason(
				makeEvent("stop"),
				makeState({ phase: "green_impl", bailReason: "impossible" }),
			),
		).toBe("tool-terminate");
	});

	it("returns interrupted on error during implementing", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "implementing" }))).toBe("interrupted");
	});

	it("returns interrupted on error during red_impl", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "red_impl" }))).toBe("interrupted");
	});

	it("returns interrupted on error during green_impl without bailReason", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "green_impl" }))).toBe("interrupted");
	});

	it("returns interrupted on error during planning (no plan yet)", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "planning" }))).toBe("interrupted");
	});

	it("returns interrupted on error during red_planning (no plan yet)", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "red_planning" }))).toBe("interrupted");
	});

	it("bail_out during green_impl with error stopReason is still tool-terminate", () => {
		expect(
			endReason(makeEvent("error"), makeState({ phase: "green_impl", bailReason: "impossible" })),
		).toBe("tool-terminate");
	});
});
