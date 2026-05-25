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
import {
	shouldShutdownInSingleShot,
	type ShutdownBoundary,
} from "../agent/extensions/bogstandard/single-shot.js";

const ALL_BOUNDARIES: readonly ShutdownBoundary[] = [
	"queued_for_merge",
	"no_change_closed",
	"no_eligible",
	"invalid_issue",
	"missing_needs_tests",
	"claim_failed",
	"dirty_tree",
	"aborted_before_planning",
	"aborted_resume_or_plan_review",
	"redraft_proposed",
	"wip_quit",
	"continue_cancelled",
	"continue_working",
] as const;

describe("shouldShutdownInSingleShot", () => {
	it("returns false for every boundary when the flag is undefined", () => {
		for (const boundary of ALL_BOUNDARIES) {
			expect(shouldShutdownInSingleShot(undefined, boundary)).toBe(false);
		}
	});

	it("returns false for every boundary when the flag is false", () => {
		for (const boundary of ALL_BOUNDARIES) {
			expect(shouldShutdownInSingleShot(false, boundary)).toBe(false);
		}
	});

	it("returns true for every terminal boundary when the flag is true", () => {
		for (const boundary of ALL_BOUNDARIES) {
			if (boundary === "continue_working") continue;
			expect(shouldShutdownInSingleShot(true, boundary)).toBe(true);
		}
	});

	it("returns false for the continue_working boundary even when the flag is true", () => {
		expect(shouldShutdownInSingleShot(true, "continue_working")).toBe(false);
	});

	it("treats queued_for_merge as a shutdown boundary (success path)", () => {
		expect(shouldShutdownInSingleShot(true, "queued_for_merge")).toBe(true);
	});

	it("treats no_change_closed as a shutdown boundary (no-commit close path)", () => {
		expect(shouldShutdownInSingleShot(true, "no_change_closed")).toBe(true);
	});
});
