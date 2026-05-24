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
			"update_issue",
			"redraft_issue",
			"add_comment",
			"block",
			"unblock",
			"archive",
		]) {
			expect(prompt).toContain(tool);
		}
	});

	it("does not advertise the removed draft_subissue or reparent tools", () => {
		expect(prompt).not.toContain("draft_subissue");
		expect(prompt).not.toContain("reparent");
	});

	it("describes creation tools as queuing drafts", () => {
		expect(prompt).toMatch(/draft/i);
	});

	it("forbids closing issues (closing belongs to /bs-task)", () => {
		expect(prompt).toMatch(/do not close/i);
	});

	it("mentions needs_tests classification", () => {
		expect(prompt).toContain("needs_tests");
	});

	it("explains the redraft path out of aborted", () => {
		expect(prompt).toMatch(/aborted/i);
		expect(prompt).toMatch(/redraft/i);
	});

	it("references /bs-task, not /bogstandard", () => {
		expect(prompt).toContain("/bs-task");
		expect(prompt).not.toContain("/bogstandard");
	});
});

describe("buildDesignerKickoffPrompt", () => {
	it("notes when the tracker is empty", () => {
		const out = buildDesignerKickoffPrompt([], [], []);
		expect(out).toMatch(/no open, draft, or aborted issues|fresh tracker/i);
	});

	it("renders each ready issue with id, priority, and title", () => {
		const out = buildDesignerKickoffPrompt(
			[{ id: 7, title: "Add login", priority: "high" }],
			[],
			[],
		);
		expect(out).toContain("#7");
		expect(out).toContain("high");
		expect(out).toContain("Add login");
	});

	it("renders a separate Pending drafts section when drafts exist", () => {
		const out = buildDesignerKickoffPrompt(
			[{ id: 3, title: "Open issue", priority: "low" }],
			[{ id: 5, title: "Draft thing", priority: "high" }],
			[],
		);
		expect(out).toMatch(/pending drafts/i);
		expect(out).toContain("#5");
		expect(out).toContain("Draft thing");
	});

	it("renders aborted issues with their reason", () => {
		const out = buildDesignerKickoffPrompt(
			[],
			[],
			[
				{
					id: 42,
					title: "Bouncy task",
					priority: "high",
					aborted_reason: "design contradicts existing API",
				},
			],
		);
		expect(out).toMatch(/aborted/i);
		expect(out).toContain("#42");
		expect(out).toContain("design contradicts existing API");
	});

	it("aborted section omits the reason gracefully when null", () => {
		const out = buildDesignerKickoffPrompt(
			[],
			[],
			[{ id: 42, title: "Bouncy", priority: "high", aborted_reason: null }],
		);
		expect(out).toContain("#42");
		expect(out).toContain("Bouncy");
	});

	it("encourages batching multiple drafts in one turn", () => {
		const out = buildDesignerKickoffPrompt([], [], []);
		expect(out).toMatch(/single turn|one turn/i);
	});
});

describe("parseDraftEditBuffer", () => {
	it("parses a valid buffer with all fields", () => {
		const buf = "title: Fix login bug\npriority: high\nneeds_tests: true\n---\nSomething is broken.";
		const result = parseDraftEditBuffer(buf);
		expect(result.title).toBe("Fix login bug");
		expect(result.priority).toBe("high");
		expect(result.needs_tests).toBe(true);
		expect(result.description).toBe("Something is broken.");
	});

	it("accepts needs_tests=false", () => {
		const buf = "title: Cosmetic tweak\npriority: low\nneeds_tests: false\n---\n";
		const result = parseDraftEditBuffer(buf);
		expect(result.needs_tests).toBe(false);
	});

	it("handles a title containing a colon", () => {
		const buf = "title: Fix the thing: colon in it\npriority: medium\nneeds_tests: true\n---\nDetails.";
		const result = parseDraftEditBuffer(buf);
		expect(result.title).toBe("Fix the thing: colon in it");
	});

	it("accepts an empty description (no text after ---)", () => {
		const buf = "title: Add feature\npriority: low\nneeds_tests: false\n---\n";
		const result = parseDraftEditBuffer(buf);
		expect(result.description).toBe("");
	});

	it("accepts a multi-line description", () => {
		const buf = "title: Refactor\npriority: critical\nneeds_tests: true\n---\nLine one.\n\nLine two.";
		const result = parseDraftEditBuffer(buf);
		expect(result.description).toBe("Line one.\n\nLine two.");
	});

	it("throws on invalid priority", () => {
		const buf = "title: Something\npriority: urgent\nneeds_tests: true\n---\n";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/Invalid priority/);
	});

	it("throws when the --- separator is missing", () => {
		const buf = "title: Something\npriority: low\nneeds_tests: true\nNo separator here.";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/Missing --- separator/);
	});

	it("throws on an empty title", () => {
		const buf = "title:   \npriority: medium\nneeds_tests: true\n---\nSome description.";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/empty title/i);
	});

	it("throws on missing needs_tests", () => {
		const buf = "title: Add feature\npriority: low\n---\n";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/needs_tests/);
	});

	it("throws on invalid needs_tests value", () => {
		const buf = "title: Add feature\npriority: low\nneeds_tests: maybe\n---\n";
		expect(() => parseDraftEditBuffer(buf)).toThrow(/needs_tests/);
	});
});
