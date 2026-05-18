import { describe, expect, it } from "vitest";
import type { IssueDetail, LockEntry } from "../agent/extensions/bogstandard/chainlink.js";
import { buildIssueDisplay, isLockStale } from "../agent/extensions/bogstandard/chainlink.js";

function issue(overrides: Partial<IssueDetail> = {}): IssueDetail {
	return { id: 1, title: "Test Issue", status: "open", ...overrides };
}

function makeLock(claimedMsAgo: number): LockEntry {
	return {
		agent_id: "test-agent",
		branch: null,
		claimed_at: new Date(Date.now() - claimedMsAgo).toISOString(),
		signed_by: "test-agent",
	};
}

describe("isLockStale", () => {
	const SIXTY_MIN = 60;

	it("fresh lock is not stale", () => {
		expect(isLockStale(makeLock(60_000), SIXTY_MIN)).toBe(false); // 1 min ago
	});

	it("old lock is stale", () => {
		expect(isLockStale(makeLock(90 * 60_000), SIXTY_MIN)).toBe(true); // 90 min ago
	});

	it("exactly at boundary is stale (strict >)", () => {
		expect(isLockStale(makeLock(SIXTY_MIN * 60_000), SIXTY_MIN)).toBe(false); // exactly 60 min → not stale
		expect(isLockStale(makeLock(SIXTY_MIN * 60_000 + 1), SIXTY_MIN)).toBe(true); // 1 ms over → stale
	});

	it("respects custom timeout", () => {
		expect(isLockStale(makeLock(6 * 60_000), 5)).toBe(true);  // 6 min, 5-min timeout → stale
		expect(isLockStale(makeLock(4 * 60_000), 5)).toBe(false); // 4 min, 5-min timeout → fresh
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
