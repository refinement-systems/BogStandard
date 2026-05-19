import { describe, expect, it, vi } from "vitest";
import type { IssueComment, IssueDetail } from "../agent/extensions/bogstandard/db.js";
import type { BogstandardPhaseEntry, BogstandardState } from "../agent/extensions/bogstandard/phases.js";
import { buildBsHeader, loadState, reconstructState, saveState } from "../agent/extensions/bogstandard/phases.js";

function makeCtx(entries: unknown[]) {
	return { sessionManager: { getEntries: () => entries } };
}

function makeEntry(data: BogstandardPhaseEntry) {
	return { type: "custom", customType: "bogstandard-phase", data };
}

describe("loadState", () => {
	it("returns idle when entries array is empty", () => {
		expect(loadState(makeCtx([]) as any)).toEqual({ phase: "idle" });
	});

	it("returns the single bogstandard-phase entry", () => {
		const ctx = makeCtx([makeEntry({ phase: "planning", issueId: 42 })]);
		expect(loadState(ctx as any)).toEqual({ phase: "planning", issueId: 42 });
	});

	it("returns the LAST of multiple bogstandard-phase entries", () => {
		const ctx = makeCtx([
			makeEntry({ phase: "planning", issueId: 42 }),
			makeEntry({ phase: "reviewing-plan", issueId: 42, plan: "my plan" }),
		]);
		const state = loadState(ctx as any);
		expect(state.phase).toBe("reviewing-plan");
		expect(state.plan).toBe("my plan");
	});

	it("ignores entries of other custom types", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "other-type", data: { phase: "planning" } },
			{ type: "message", role: "user", content: "hello" },
		]);
		expect(loadState(ctx as any)).toEqual({ phase: "idle" });
	});

	it("ignores entries with null data", () => {
		const ctx = makeCtx([{ type: "custom", customType: "bogstandard-phase", data: null }]);
		expect(loadState(ctx as any)).toEqual({ phase: "idle" });
	});

	it("ignores entries where data.phase is not a string", () => {
		const ctx = makeCtx([
			{ type: "custom", customType: "bogstandard-phase", data: { phase: 99 } },
		]);
		expect(loadState(ctx as any)).toEqual({ phase: "idle" });
	});

	it("restores all optional TDD fields", () => {
		const entry: BogstandardPhaseEntry = {
			phase: "implementing-green",
			issueId: 7,
			plan: "green plan",
			redDiff: "diff --git a/x.ts ...",
			bailReason: "tests impossible",
		};
		const ctx = makeCtx([makeEntry(entry)]);
		expect(loadState(ctx as any)).toEqual({
			phase: "implementing-green",
			issueId: 7,
			plan: "green plan",
			redDiff: "diff --git a/x.ts ...",
			bailReason: "tests impossible",
		});
	});
});

describe("saveState", () => {
	function capturePi() {
		const calls: Array<{ type: string; data: any }> = [];
		return {
			pi: { appendEntry: (type: string, data: unknown) => calls.push({ type, data }) },
			calls,
		};
	}

	it("calls appendEntry with 'bogstandard-phase' type", () => {
		const { pi, calls } = capturePi();
		saveState(pi as any, { phase: "planning", issueId: 1 });
		expect(calls).toHaveLength(1);
		expect(calls[0].type).toBe("bogstandard-phase");
	});

	it("persists phase and issueId", () => {
		const { pi, calls } = capturePi();
		saveState(pi as any, { phase: "implementing-red", issueId: 99 });
		expect(calls[0].data.phase).toBe("implementing-red");
		expect(calls[0].data.issueId).toBe(99);
	});

	it("persists optional TDD fields when present", () => {
		const { pi, calls } = capturePi();
		const state: BogstandardState = {
			phase: "implementing-green",
			issueId: 1,
			plan: "the plan",
			redDiff: "the diff",
			bailReason: "bad tests",
		};
		saveState(pi as any, state);
		const { data } = calls[0];
		expect(data.plan).toBe("the plan");
		expect(data.redDiff).toBe("the diff");
		expect(data.bailReason).toBe("bad tests");
	});

	it("writes undefined for absent optional fields (no phantom data)", () => {
		const { pi, calls } = capturePi();
		saveState(pi as any, { phase: "done", issueId: 5 });
		const { data } = calls[0];
		expect(data.plan).toBeUndefined();
		expect(data.redDiff).toBeUndefined();
		expect(data.bailReason).toBeUndefined();
	});
});

// ── reconstructState ─────────────────────────────────────────────────────────

function makeComment(event: string, attrs: Record<string, string> = {}, body = ""): IssueComment {
	const header = buildBsHeader(event, attrs);
	return { kind: "result", content: body ? `${header}\n\n${body}` : header };
}

function makeIssue(comments: IssueComment[]): IssueDetail {
	return { id: 1, title: "test issue", status: "open", comments };
}

describe("reconstructState", () => {
	it("returns idle when there are no comments", async () => {
		expect(await reconstructState(makeIssue([]))).toEqual({ phase: "idle" });
	});

	it("returns idle when comments have no BogStandard headers", async () => {
		const issue = makeIssue([{ kind: "human", content: "just a comment" }]);
		expect(await reconstructState(issue)).toEqual({ phase: "idle" });
	});

	it("path-chosen no-tests → planning", async () => {
		const issue = makeIssue([makeComment("path-chosen", { path: "no-tests" })]);
		expect(await reconstructState(issue)).toEqual({ phase: "planning", issueId: 1 });
	});

	it("path-chosen tdd → planning-red", async () => {
		const issue = makeIssue([makeComment("path-chosen", { path: "tdd" })]);
		expect(await reconstructState(issue)).toEqual({ phase: "planning-red", issueId: 1 });
	});

	it("plan-accepted planning → implementing with plan body", async () => {
		const issue = makeIssue([makeComment("plan-accepted", { phase: "planning" }, "## the plan")]);
		const state = await reconstructState(issue);
		expect(state.phase).toBe("implementing");
		expect(state.issueId).toBe(1);
		expect(state.plan).toBe("## the plan");
	});

	it("plan-accepted planning-red → implementing-red with plan body", async () => {
		const issue = makeIssue([makeComment("plan-accepted", { phase: "planning-red" }, "red plan")]);
		const state = await reconstructState(issue);
		expect(state.phase).toBe("implementing-red");
		expect(state.plan).toBe("red plan");
	});

	it("red-commit → planning-green, calls gitShow with sha", async () => {
		const gitShow = vi.fn().mockResolvedValue("diff content");
		const issue = makeIssue([makeComment("red-commit", { sha: "abc123" })]);
		const state = await reconstructState(issue, gitShow);
		expect(state.phase).toBe("planning-green");
		expect(state.issueId).toBe(1);
		expect(state.redDiff).toBe("diff content");
		expect(gitShow).toHaveBeenCalledWith("abc123");
	});

	it("red-commit without gitShow → planning-green with undefined redDiff", async () => {
		const issue = makeIssue([makeComment("red-commit", { sha: "abc123" })]);
		const state = await reconstructState(issue);
		expect(state.phase).toBe("planning-green");
		expect(state.redDiff).toBeUndefined();
	});

	it("plan-accepted planning-green → implementing-green with plan and redDiff", async () => {
		const gitShow = vi.fn().mockResolvedValue("red diff");
		const issue = makeIssue([
			makeComment("red-commit", { sha: "deadbeef" }),
			makeComment("plan-accepted", { phase: "planning-green" }, "green plan"),
		]);
		const state = await reconstructState(issue, gitShow);
		expect(state.phase).toBe("implementing-green");
		expect(state.plan).toBe("green plan");
		expect(state.redDiff).toBe("red diff");
		expect(gitShow).toHaveBeenCalledWith("deadbeef");
	});

	it("green-bail after plan-accepted planning-green → planning-red (bail resets)", async () => {
		const issue = makeIssue([
			makeComment("plan-accepted", { phase: "planning-green" }, "green plan"),
			makeComment("green-bail"),
		]);
		const state = await reconstructState(issue);
		expect(state.phase).toBe("planning-red");
		expect(state.plan).toBeUndefined();
	});

	it("final-commit → done", async () => {
		const issue = makeIssue([makeComment("final-commit", { sha: "abc" })]);
		expect(await reconstructState(issue)).toEqual({ phase: "done", issueId: 1 });
	});

	it("closed → done", async () => {
		const issue = makeIssue([makeComment("closed")]);
		expect(await reconstructState(issue)).toEqual({ phase: "done", issueId: 1 });
	});

	it("last plan-accepted wins when multiple exist", async () => {
		const issue = makeIssue([
			makeComment("plan-accepted", { phase: "planning" }, "first plan"),
			makeComment("plan-accepted", { phase: "planning" }, "second plan"),
		]);
		const state = await reconstructState(issue);
		expect(state.plan).toBe("second plan");
	});

	it("gitShow throwing → redDiff is a non-empty placeholder string, no crash", async () => {
		const gitShow = vi.fn().mockRejectedValue(new Error("git not available"));
		const issue = makeIssue([makeComment("red-commit", { sha: "abc" })]);
		const state = await reconstructState(issue, gitShow);
		expect(state.phase).toBe("planning-green");
		expect(typeof state.redDiff).toBe("string");
		expect(state.redDiff!.length).toBeGreaterThan(0);
	});
});
