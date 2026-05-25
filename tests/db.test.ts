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
import type { IssueDetail, Phase } from "../agent/extensions/bogstandard/db.js";
import {
	ALL_PHASES,
	buildIssueDisplay,
	isPhaseStale,
	isWorkingPhase,
} from "../agent/extensions/bogstandard/db.js";

function issue(overrides: Partial<IssueDetail> = {}): IssueDetail {
	return {
		id: 1,
		title: "Test Issue",
		phase: "ready",
		current_version_id: 1,
		current_version_no: 1,
		...overrides,
	};
}

function isoMsAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

describe("isPhaseStale", () => {
	const SIXTY_MIN = 60;

	it("fresh phase_started_at is not stale", () => {
		expect(isPhaseStale(isoMsAgo(60_000), SIXTY_MIN)).toBe(false);
	});

	it("old phase_started_at is stale", () => {
		expect(isPhaseStale(isoMsAgo(90 * 60_000), SIXTY_MIN)).toBe(true);
	});

	it("exactly at boundary is not stale (strict >)", () => {
		expect(isPhaseStale(isoMsAgo(SIXTY_MIN * 60_000), SIXTY_MIN)).toBe(false);
		expect(isPhaseStale(isoMsAgo(SIXTY_MIN * 60_000 + 1), SIXTY_MIN)).toBe(true);
	});

	it("respects custom timeout", () => {
		expect(isPhaseStale(isoMsAgo(6 * 60_000), 5)).toBe(true);
		expect(isPhaseStale(isoMsAgo(4 * 60_000), 5)).toBe(false);
	});

	it("null timestamp is not stale (no owner)", () => {
		expect(isPhaseStale(null, SIXTY_MIN)).toBe(false);
	});
});

describe("ALL_PHASES", () => {
	it("includes the four merge-flow phases between *_impl and done", () => {
		expect(ALL_PHASES).toContain("merging_pending");
		expect(ALL_PHASES).toContain("merging");
		expect(ALL_PHASES).toContain("merge_repair");
		expect(ALL_PHASES).toContain("merge_failed");
	});

	it("orders merge phases after green_impl and before done", () => {
		const idx = (p: Phase) => ALL_PHASES.indexOf(p);
		expect(idx("merging_pending")).toBeGreaterThan(idx("green_impl"));
		expect(idx("merging")).toBeGreaterThan(idx("merging_pending"));
		expect(idx("merge_repair")).toBeGreaterThan(idx("merging"));
		expect(idx("merge_failed")).toBeGreaterThan(idx("merge_repair"));
		expect(idx("done")).toBeGreaterThan(idx("merge_failed"));
	});
});

describe("isWorkingPhase", () => {
	it.each<Phase>(["planning", "implementing", "red_planning", "red_impl", "green_planning", "green_impl"])(
		"%s is a working phase",
		(p) => {
			expect(isWorkingPhase(p)).toBe(true);
		},
	);

	it.each<Phase>([
		"drafting",
		"ready",
		"merging_pending",
		"merging",
		"merge_repair",
		"merge_failed",
		"done",
		"aborted",
		"archived",
	])("%s is not a working phase", (p) => {
		expect(isWorkingPhase(p)).toBe(false);
	});
});

describe("buildIssueDisplay", () => {
	it("returns empty string for an issue with no description or comments", () => {
		expect(buildIssueDisplay(issue())).toBe("");
	});

	it("returns just the description when there are no comments", () => {
		expect(buildIssueDisplay(issue({ description: "My description" }))).toBe("My description");
	});

	it("returns empty string for a whitespace-only description", () => {
		expect(buildIssueDisplay(issue({ description: "   " }))).toBe("");
	});

	it("returns empty string for a null description with no comments", () => {
		expect(buildIssueDisplay(issue({ description: null }))).toBe("");
	});

	it("formats a single comment with kind and content", () => {
		const result = buildIssueDisplay(issue({ comments: [{ kind: "human", content: "A comment" }] }));
		expect(result).toBe("# Comment (human)\n\nA comment");
	});

	it("joins description and comments with double newlines", () => {
		const result = buildIssueDisplay(
			issue({ description: "Desc", comments: [{ kind: "plan", content: "Plan text" }] }),
		);
		expect(result).toBe("Desc\n\n# Comment (plan)\n\nPlan text");
	});

	it("concatenates multiple comments separated by double newlines", () => {
		const result = buildIssueDisplay(
			issue({
				comments: [
					{ kind: "human", content: "First" },
					{ kind: "result", content: "Second" },
				],
			}),
		);
		expect(result).toBe("# Comment (human)\n\nFirst\n\n# Comment (result)\n\nSecond");
	});

	it("handles an empty comments array gracefully", () => {
		expect(buildIssueDisplay(issue({ comments: [] }))).toBe("");
	});
});
