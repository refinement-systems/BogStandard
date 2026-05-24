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

/**
 * Pure utilities for the draft edit-buffer format used in the Designer's
 * review UI.
 *
 * Buffer format:
 *   title: <one line of free text, may contain colons>
 *   priority: low | medium | high | critical
 *   needs_tests: true | false
 *   ---
 *   <description markdown body, may be empty>
 *
 * Parsing rules:
 *   - Find the first line that is exactly "---"; everything above is the
 *     header, everything below is the description body.
 *   - Header lines are parsed as "key: value" by splitting on the first ": ".
 *     Any line without ": " is silently skipped.
 *   - Title may contain colons; only the first ": " is used as the delimiter.
 */

import { assertPriority } from "./db.js";
import type { IssueDetail } from "./db.js";

export interface DraftEditFields {
	title: string;
	priority: string;
	needs_tests: boolean;
	description: string;
}

export function parseDraftEditBuffer(text: string): DraftEditFields {
	const lines = text.split("\n");
	const sepIdx = lines.findIndex((l) => l === "---");
	if (sepIdx < 0) {
		throw new Error("Missing --- separator between header and description");
	}
	const fields: Record<string, string> = {};
	for (const line of lines.slice(0, sepIdx)) {
		const colon = line.indexOf(": ");
		if (colon < 0) continue;
		fields[line.slice(0, colon).trim()] = line.slice(colon + 2);
	}
	const title = fields["title"]?.trim();
	if (!title) throw new Error("Missing or empty title field");
	const priority = fields["priority"]?.trim() ?? "";
	assertPriority(priority);
	const rawNeedsTests = fields["needs_tests"]?.trim().toLowerCase() ?? "";
	if (rawNeedsTests !== "true" && rawNeedsTests !== "false") {
		throw new Error(
			`needs_tests must be 'true' or 'false' (got '${rawNeedsTests || "(missing)"}')`,
		);
	}
	const description = lines.slice(sepIdx + 1).join("\n").trim();
	return { title, priority, needs_tests: rawNeedsTests === "true", description };
}

export function formatDraftForEdit(issue: IssueDetail): string {
	const needs = issue.needs_tests === null || issue.needs_tests === undefined ? "false" : String(issue.needs_tests);
	return `title: ${issue.title}\npriority: ${issue.priority ?? "medium"}\nneeds_tests: ${needs}\n---\n${issue.description ?? ""}`;
}

export function formatDraftForReview(issue: IssueDetail): string {
	const parts = [
		`**Priority:** ${issue.priority ?? "medium"}`,
		`**Needs tests:** ${issue.needs_tests === null || issue.needs_tests === undefined ? "(unset)" : String(issue.needs_tests)}`,
	];
	if (issue.description?.trim()) parts.push("", issue.description);
	return parts.join("\n");
}
