import { describe, expect, it } from "vitest";
import { assertPriority } from "../agent/extensions/bogstandard/db.js";
import {
	buildDesignerKickoffPrompt,
	buildDesignerSystemPrompt,
} from "../agent/extensions/bogstandard/designer-prompts.js";

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
			"create_issue",
			"create_subissue",
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

	it("forbids closing issues (closing belongs to /bs-task)", () => {
		expect(prompt).toMatch(/do not close/i);
	});

	it("references the rebranded /bs-task command, not /bogstandard", () => {
		expect(prompt).toContain("/bs-task");
		expect(prompt).not.toContain("/bogstandard");
	});
});

describe("buildDesignerKickoffPrompt", () => {
	it("notes when there are no open issues", () => {
		const out = buildDesignerKickoffPrompt([]);
		expect(out).toMatch(/no open issues/i);
	});

	it("renders each open issue with id, priority, and title", () => {
		const out = buildDesignerKickoffPrompt([
			{ id: 7, title: "Add login", priority: "high", parent_id: null },
		]);
		expect(out).toContain("#7");
		expect(out).toContain("high");
		expect(out).toContain("Add login");
	});

	it("marks subissues with their parent id", () => {
		const out = buildDesignerKickoffPrompt([
			{ id: 12, title: "Form validation", priority: "medium", parent_id: 7 },
		]);
		expect(out).toContain("subissue of #7");
	});

	it("does not start creating without operator confirmation", () => {
		const out = buildDesignerKickoffPrompt([]);
		expect(out).toMatch(/do not start creating/i);
	});
});
