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
import { endReason } from "../agent/extensions/bogstandard/phases.js";
import type { BogstandardState } from "../agent/extensions/bogstandard/phases.js";

function makeEvent(stopReason?: string) {
	const lastMsg = stopReason !== undefined ? { role: "assistant", stopReason } : { role: "assistant" };
	return { messages: [lastMsg] };
}

function makeState(overrides: Partial<BogstandardState> = {}): BogstandardState {
	return { phase: "implementing", ...overrides };
}

describe("endReason", () => {
	it("returns completed on natural stop during implementing", () => {
		expect(endReason(makeEvent("stop"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed on natural stop during implementing-green", () => {
		expect(endReason(makeEvent("stop"), makeState({ phase: "implementing-green" }))).toBe("completed");
	});

	it("returns tool-terminate when phase is reviewing-plan (save_plan path)", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "reviewing-plan" }))).toBe("tool-terminate");
	});

	it("returns tool-terminate when phase is reviewing-red-plan", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "reviewing-red-plan" }))).toBe("tool-terminate");
	});

	it("returns tool-terminate when phase is reviewing-green-plan", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "reviewing-green-plan" }))).toBe("tool-terminate");
	});

	it("returns tool-terminate when implementing-green with bailReason set (bail_out path)", () => {
		expect(
			endReason(
				makeEvent("aborted"),
				makeState({ phase: "implementing-green", bailReason: "impossible" }),
			),
		).toBe("tool-terminate");
	});

	it("returns interrupted on aborted during implementing", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "implementing" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during implementing-red", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "implementing-red" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during implementing-green without bailReason", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "implementing-green" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during planning", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "planning" }))).toBe("interrupted");
	});

	it("returns interrupted on aborted during planning-red", () => {
		expect(endReason(makeEvent("aborted"), makeState({ phase: "planning-red" }))).toBe("interrupted");
	});

	it("returns completed when messages array is empty", () => {
		expect(endReason({ messages: [] }, makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed for stopReason length", () => {
		expect(endReason(makeEvent("length"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed for stopReason toolUse", () => {
		expect(endReason(makeEvent("toolUse"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("returns completed for stopReason error", () => {
		expect(endReason(makeEvent("error"), makeState({ phase: "implementing" }))).toBe("completed");
	});

	it("bail_out during implementing-green without aborted stopReason is still tool-terminate", () => {
		// bail_out sets bailReason; stopReason check is secondary
		expect(
			endReason(
				makeEvent("stop"),
				makeState({ phase: "implementing-green", bailReason: "impossible" }),
			),
		).toBe("tool-terminate");
	});
});
