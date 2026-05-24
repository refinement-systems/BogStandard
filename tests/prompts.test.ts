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
import type { IssueDetail } from "../agent/extensions/bogstandard/db.js";
import {
	buildGreenImplementPrompt,
	buildGreenImplementerSystemPrompt,
	buildGreenPlanPrompt,
	buildImplementPrompt,
	buildImplementerSystemPrompt,
	buildPlanPrompt,
	buildPlannerSystemPrompt,
	buildRedImplementPrompt,
	buildRedPlanPrompt,
} from "../agent/extensions/bogstandard/prompts.js";

const ISSUE: IssueDetail = {
	id: 42,
	title: "Implement feature X",
	phase: "ready",
	current_version_id: 1,
	current_version_no: 1,
	needs_tests: false,
	description: "We need feature X.",
	comments: [
		{ kind: "human", content: "Please keep it simple." },
		{ kind: "note", content: "Design note here." },
		{ kind: "decision", content: "Use pattern A." },
		{ kind: "observation", content: "Repo uses ESM." },
		{ kind: "blocker", content: "Was blocked by issue 7." },
		{ kind: "carry_forward", content: "Carried from v1." },
		{ kind: "result", content: "Prior attempt failed." },
		{ kind: "handoff", content: "Handed off to worker-2." },
	],
	blocked_by: [7],
	subissues: [{ id: 10, phase: "done" }],
};

const PLAN = "# Plan\n\nStep 1: do the thing.";
const RED_DIFF = "diff --git a/tests/x.test.ts b/tests/x.test.ts\n+++ b/tests/x.test.ts";

describe("buildPlanPrompt", () => {
	it("contains the issue id and title", () => {
		const prompt = buildPlanPrompt(ISSUE);
		expect(prompt).toContain("Issue #42");
		expect(prompt).toContain("Implement feature X");
	});

	it("inlines the issue description", () => {
		expect(buildPlanPrompt(ISSUE)).toContain("We need feature X.");
	});

	it("inlines issue comments", () => {
		expect(buildPlanPrompt(ISSUE)).toContain("Please keep it simple.");
	});

	it("instructs the agent to call save_plan", () => {
		expect(buildPlanPrompt(ISSUE)).toContain("save_plan");
	});

	it("does not prohibit writing tests", () => {
		expect(buildPlanPrompt(ISSUE)).not.toContain("opted out of tests");
	});

	it("strips blocked_by and subissues from the JSON block", () => {
		const prompt = buildPlanPrompt(ISSUE);
		expect(prompt).not.toContain('"blocked_by"');
		expect(prompt).not.toContain('"subissues"');
	});

	it("includes allowed comment kinds in the prompt", () => {
		const prompt = buildPlanPrompt(ISSUE);
		expect(prompt).toContain("Please keep it simple.");
		expect(prompt).toContain("Design note here.");
		expect(prompt).toContain("Use pattern A.");
		expect(prompt).toContain("Repo uses ESM.");
	});

	it("strips disallowed comment kinds from the prompt", () => {
		const prompt = buildPlanPrompt(ISSUE);
		expect(prompt).not.toContain("Was blocked by issue 7.");
		expect(prompt).not.toContain("Carried from v1.");
		expect(prompt).not.toContain("Prior attempt failed.");
		expect(prompt).not.toContain("Handed off to worker-2.");
	});

	it("uses the updated JSON label", () => {
		expect(buildPlanPrompt(ISSUE)).toContain("Raw JSON (fields: title, description, priority, needs_tests, comments):");
	});
});

describe("buildImplementPrompt", () => {
	it("contains the issue id and title", () => {
		const prompt = buildImplementPrompt(ISSUE, PLAN);
		expect(prompt).toContain("Issue #42");
		expect(prompt).toContain("Implement feature X");
	});

	it("embeds the approved plan verbatim", () => {
		expect(buildImplementPrompt(ISSUE, PLAN)).toContain(PLAN);
	});
});

describe("buildRedPlanPrompt", () => {
	it("contains the issue id and title", () => {
		const prompt = buildRedPlanPrompt(ISSUE);
		expect(prompt).toContain("Issue #42");
		expect(prompt).toContain("Implement feature X");
	});

	it("identifies itself as the red phase", () => {
		expect(buildRedPlanPrompt(ISSUE)).toContain("red");
	});

	it("instructs the agent to call save_plan", () => {
		expect(buildRedPlanPrompt(ISSUE)).toContain("save_plan");
	});

	it("focuses on tests, not production code", () => {
		const prompt = buildRedPlanPrompt(ISSUE);
		expect(prompt).toContain("test");
		expect(prompt).toContain("Do NOT plan any production-code changes");
	});

	it("strips blocked_by and subissues from the JSON block", () => {
		const prompt = buildRedPlanPrompt(ISSUE);
		expect(prompt).not.toContain('"blocked_by"');
		expect(prompt).not.toContain('"subissues"');
	});

	it("strips disallowed comment kinds from the prompt", () => {
		const prompt = buildRedPlanPrompt(ISSUE);
		expect(prompt).not.toContain("Was blocked by issue 7.");
		expect(prompt).not.toContain("Carried from v1.");
	});

	it("warns against testing already-implemented behavior", () => {
		expect(buildRedPlanPrompt(ISSUE)).toContain("already implemented");
	});
});

describe("buildRedImplementPrompt", () => {
	it("contains the issue title and embeds the plan", () => {
		const prompt = buildRedImplementPrompt(ISSUE, PLAN);
		expect(prompt).toContain("Implement feature X");
		expect(prompt).toContain(PLAN);
	});

	it("requires tests to fail (red deliverable)", () => {
		expect(buildRedImplementPrompt(ISSUE, PLAN)).toContain("failing");
	});

	it("prohibits production code changes", () => {
		expect(buildRedImplementPrompt(ISSUE, PLAN)).toContain("Write tests only");
	});

	it("prohibits skip/xfail markers", () => {
		const prompt = buildRedImplementPrompt(ISSUE, PLAN);
		expect(prompt).toContain("skip");
		expect(prompt).toContain("xfail");
	});
});

describe("buildGreenPlanPrompt", () => {
	it("contains the issue title and embeds the red diff", () => {
		const prompt = buildGreenPlanPrompt(ISSUE, RED_DIFF);
		expect(prompt).toContain("Implement feature X");
		expect(prompt).toContain(RED_DIFF);
	});

	it("identifies itself as the green phase", () => {
		expect(buildGreenPlanPrompt(ISSUE, RED_DIFF)).toContain("green");
	});

	it("instructs the agent to call save_plan", () => {
		expect(buildGreenPlanPrompt(ISSUE, RED_DIFF)).toContain("save_plan");
	});

	it("prohibits listing test files in the plan", () => {
		expect(buildGreenPlanPrompt(ISSUE, RED_DIFF)).toContain("Do not list test files here");
	});
});

describe("buildGreenImplementPrompt", () => {
	it("contains the issue title, plan, and red diff", () => {
		const prompt = buildGreenImplementPrompt(ISSUE, PLAN, RED_DIFF);
		expect(prompt).toContain("Implement feature X");
		expect(prompt).toContain(PLAN);
		expect(prompt).toContain(RED_DIFF);
	});

	it("references the bail_out tool", () => {
		expect(buildGreenImplementPrompt(ISSUE, PLAN, RED_DIFF)).toContain("bail_out");
	});

	it("prohibits modifying test files from the red phase", () => {
		expect(buildGreenImplementPrompt(ISSUE, PLAN, RED_DIFF)).toContain("Do NOT modify");
	});

	it("requires the tests to pass (green deliverable)", () => {
		expect(buildGreenImplementPrompt(ISSUE, PLAN, RED_DIFF)).toContain("tests pass");
	});
});

describe("buildPlannerSystemPrompt", () => {
	it("identifies the agent as a software architect", () => {
		expect(buildPlannerSystemPrompt()).toContain("software architect");
	});

	it("describes the questionnaire tool", () => {
		expect(buildPlannerSystemPrompt()).toContain("questionnaire");
	});

	it("describes the save_plan tool", () => {
		expect(buildPlannerSystemPrompt()).toContain("save_plan");
	});

	it("describes the propose_redraft tool", () => {
		expect(buildPlannerSystemPrompt()).toContain("propose_redraft");
	});

	it("prohibits file modification", () => {
		expect(buildPlannerSystemPrompt()).toContain("Do not modify");
	});

	it("prohibits git commands", () => {
		expect(buildPlannerSystemPrompt()).toContain("git");
	});

	it("prohibits direct issue database access", () => {
		expect(buildPlannerSystemPrompt()).toContain("issue database");
	});
});

describe("buildImplementerSystemPrompt", () => {
	it("identifies the agent as a software engineer", () => {
		expect(buildImplementerSystemPrompt()).toContain("software engineer");
	});

	it("prohibits git commands", () => {
		expect(buildImplementerSystemPrompt()).toContain("git");
	});

	it("prohibits direct issue database access", () => {
		expect(buildImplementerSystemPrompt()).toContain("issue database");
	});
});

describe("buildGreenImplementerSystemPrompt", () => {
	it("extends the implementer prompt", () => {
		expect(buildGreenImplementerSystemPrompt()).toContain("software engineer");
	});

	it("describes the bail_out tool", () => {
		expect(buildGreenImplementerSystemPrompt()).toContain("bail_out");
	});
});
