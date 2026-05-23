/**
 * Pure utilities for the draft edit-buffer format used in the Designer's
 * review UI. Extracted into its own module so they can be unit-tested without
 * pulling in the pi extension runtime or typebox.
 *
 * Buffer format:
 *   title: <one line of free text, may contain colons>
 *   priority: low | medium | high | critical
 *   ---
 *   <description markdown body, may be empty>
 *
 * Parsing rules:
 *   - Find the first line that is exactly "---"; everything above is the header,
 *     everything below is the description body.
 *   - Header lines are parsed as "key: value" by splitting on the first ": ".
 *     Any line without ": " is silently skipped.
 *   - Title may contain colons; only the first ": " is used as the delimiter.
 */

import { assertPriority } from "./db.js";
import type { IssueDetail } from "./db.js";

export interface DraftEditFields {
	title: string;
	priority: string;
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
	const description = lines.slice(sepIdx + 1).join("\n").trim();
	return { title, priority, description };
}

export function formatDraftForEdit(issue: IssueDetail): string {
	return `title: ${issue.title}\npriority: ${issue.priority ?? "medium"}\n---\n${issue.description ?? ""}`;
}

export function formatDraftForReview(issue: IssueDetail): string {
	const parts = [`**Priority:** ${issue.priority ?? "medium"}`];
	if (issue.description?.trim()) parts.push("", issue.description);
	return parts.join("\n");
}
