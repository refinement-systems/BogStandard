import { describe, expect, it } from "vitest";
import { assertPriority } from "../agent/extensions/bogstandard/db.js";
import {
	buildDesignerKickoffPrompt,
	buildDesignerSystemPrompt,
} from "../agent/extensions/bogstandard/designer-prompts.js";
import { parseDraftEditBuffer } from "../agent/extensions/bogstandard/draft-edit.js";

describe("assertPriority", () => {
	it.each(["low", "medium", "high", "critical"])(
		"accepts the schema-valid priority '%s'",
		(p) => {
			expect(() => assertPriority(p)).not.toThrow();
		},
	);

	it.each(["", "urgent", "Low", "MEDIUM", " high", "high\n", "'; DROP TABLE issues; --"])(
		"rejects '%s'",
		(p) => {
			expect(() => assertPriority(p)).toThrow(/Invalid priority/);
		},
	);
});

describe("buildDesignerSystemPrompt", () => {
	const prompt = buildDesignerSystemPrompt();

	it("lists every Designer tool", () => {
		for (const tool of [
			"list_issues",
			"show_issue",
			"draft_issue",
			"draft_subissue",
			"update_issue",
			"add_comment",
			"block",
			"unblock",
			"reparent",
			"archive",
		]) {
			expect(prompt).toContain(tool);
		}
	});

	it("describes creation tools as queuing drafts", () => {
		expect(prompt).toMatch(/draft/i);
	});

	it("forbids closing issues (closing belongs to /bs-task)", () => {
		expect(prompt).toMatch(/do not close/i);
	});

	it("references the rebranded /bs-task command, not /bogstandard", () => {
		expect(prompt).toContain("/bs-task");
		expect(prompt).not.toContain("/bogstandard");
	});
});

describe("buildDesignerKickoffPrompt", () => {
	it("notes when there are no open or draft issues", () => {
		const out = buildDesignerKickoffPrompt([], []);
		expect(out).toMatch(/no open or draft issues/i);
	});

	it("renders each open issue with id, priority, and title", () => {
		const out = buildDesignerKickoffPrompt(
			[{ id: 7, title: "Add login", priority: "high", parent_id: null }],
			[],
		);
		expect(out).toContain("#7");
		expect(out).toContain("high");
		expect(out).toContain("Add login");
	});

	it("marks subissues with their parent id", () => {
		const out = buildDesignerKickoffPrompt(
			[{ id: 12, title: "Form validation", priority: "medium", parent_id: 7 }],
			[],
		);
		expect(out).toContain("subissue of #7");
	});

	it("renders a separate Pending drafts section when drafts exist", () => {
		const out = buildDesignerKickoffPrompt(
			[{ id: 3, title: "Open issue", priority: "low", parent_id: null }],
			[{ id: 5, title: "Draft thing", priority: "high", parent_id: null }],
		);
		expect(out).toMatch(/pending drafts/i);
		expect(out).toContain("#5");
		expect(out).toContain("Draft thing");
	});

	it("encourages batching multiple drafts in one turn", () => {
		const out = buildDesignerKickoffPrompt([], []);
		expect(out).toMatch(/single turn|one turn/i);
	});
});

describe("parseDraftEditBuffer", () => {
	it("parses a valid buffer with all fields", () => {
		const buf = "title: Fix login bug\npriority: high\n---\nSomething is broken.";
		const result = parseDraftEditBuffer(buf);
		expect(result.title).toBe("Fix login bug");
		expect(result.priority).toBe("high");
		expect(result.description).toBe("Something is broken.");
	});

	it("handles a title containing a colon", () => {
		const buf = "title: Fix the thing: colon in it\npriority: medium\n---\nDetails.";
		const result = parseDraftEditBuffer(buf);
		expect(result.title).toBe("Fix the thing: colon in it");
	});

	it("accepts an empty description (no text after ---)", () => {
		const buf = "title: Add feature\npriority: low\n---\n";
		const result = parseDraftEditBuffer(buf);
		expect(result.description).toBe("");
	});

	it("accepts a multi-line description", () => {
		const buf = "title: Refactor\npriority: critical\n---\nLine one.\n\nLine two.";
		const result = parseDraftEditBuffer(buf);
		expect(result.description).toBe("Line one.\n\nLine two.");
	});

	it("throws on invalid priority", () => {
		const buf = "title: Something\npriority: urgent\n---\n";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/Invalid priority/);
	});

	it("throws when the --- separator is missing", () => {
		const buf = "title: Something\npriority: low\nNo separator here.";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/Missing --- separator/);
	});

	it("throws on an empty title", () => {
		const buf = "title:   \npriority: medium\n---\nSome description.";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/empty title/i);
	});
});
