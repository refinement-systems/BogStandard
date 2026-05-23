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
 * BogStandard Designer stage.
 *
 * Registers the `/bs-design` command and the Designer tool set. The Designer
 * is a conversational session for brainstorming and creating issues — it
 * does not participate in the planner/implementer phase state machine.
 *
 * Tools are registered once at extension boot; `pi.setActiveTools(...)` in
 * the command handler limits the model to the Designer surface while the
 * session is in design mode.
 *
 * Draft workflow: `draft_issue` / `draft_subissue` create issues with
 * status='draft'. After each agent turn that queued ≥1 draft, the operator
 * reviews them one by one (approve / edit / skip). Skipped drafts are sent
 * back to the agent with operator feedback for revision.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import {
	configureDb,
	dependencyAdd,
	dependencyRemove,
	issueArchive,
	issueCreate,
	issueDraftApprove,
	issueListFiltered,
	issueSetParent,
	issueShowJson,
	issueUpdate,
	issueComment,
	type IssueDetail,
} from "./db.js";
import { buildDesignerKickoffPrompt, buildDesignerSystemPrompt } from "./designer-prompts.js";
import { showScrollableMarkdown } from "./scrollable-markdown.js";
import { formatDraftForEdit, formatDraftForReview, parseDraftEditBuffer } from "./draft-edit.js";
export { parseDraftEditBuffer } from "./draft-edit.js";

const DESIGN_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
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
];

const PRIORITY_SCHEMA = Type.Union(
	[Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")],
	{ description: "Priority: low, medium, high, or critical" },
);

const STATUS_SCHEMA = Type.Union(
	[
		Type.Literal("open"),
		Type.Literal("closed"),
		Type.Literal("archived"),
		Type.Literal("draft"),
	],
	{ description: "Issue status filter" },
);

export interface RegisterDesignerOptions {
	/**
	 * Returns true if the /bs-task state machine is mid-flow. The Designer
	 * refuses to run while a task is active to keep the active tool set sane.
	 */
	isTaskActive: () => boolean;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDesigner(pi: ExtensionAPI, opts: RegisterDesignerOptions): void {
	// Closure flag flipped on by /bs-design and consumed by before_agent_start
	// to swap in the Designer system prompt. Not persisted across sessions —
	// re-run /bs-design after `pi -r` to reactivate.
	let designerActive = false;

	// IDs of drafts created during the current agent turn. Consumed and cleared
	// by the agent_end handler that shows the review UI.
	let pendingDraftIds: number[] = [];

	registerDesignerTools(pi, () => pendingDraftIds);

	pi.registerCommand("bs-design", {
		description: "Brainstorm and create issues with a Designer agent",
		handler: async (_args, ctx) => {
			if (opts.isTaskActive()) {
				ctx.ui.notify(
					"A /bs-task session is already in progress. Resolve or /new to start a Designer session.",
					"warning",
				);
				return;
			}

			try {
				configureDb(
					loadConfig({
						projectRoot: process.cwd(),
						flagDatabaseUrl: pi.getFlag("bs-database-url") as string | undefined,
						flagAgentId: pi.getFlag("bs-agent-id") as string | undefined,
					}),
				);
			} catch (err) {
				ctx.ui.notify(
					`bs-design: postgres configuration not loaded — ${err instanceof Error ? err.message : String(err)}. Run 'bs-setup' to create .bogstandard/config.json.`,
					"error",
				);
				return;
			}

			let openIssues: Array<{ id: number; title: string; priority?: string; parent_id: number | null }> = [];
			let draftIssues: Array<{ id: number; title: string; priority?: string; parent_id: number | null }> = [];
			try {
				openIssues = await issueListFiltered(pi, { status: "open" });
				draftIssues = await issueListFiltered(pi, { status: "draft" });
			} catch (err) {
				ctx.ui.notify(`Failed to list issues: ${err}`, "error");
				return;
			}

			designerActive = true;
			pendingDraftIds = [];
			pi.setActiveTools(DESIGN_TOOLS);

			const kickoff = buildDesignerKickoffPrompt(openIssues, draftIssues);
			pi.sendMessage(
				{ customType: "bs-design-kickoff", content: kickoff, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	pi.on("before_agent_start", async () => {
		if (designerActive && !opts.isTaskActive()) {
			return { systemPrompt: buildDesignerSystemPrompt() };
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!designerActive || pendingDraftIds.length === 0) return;
		const ids = [...pendingDraftIds];
		pendingDraftIds = [];
		await runDraftReviewLoop(ctx, ids);
	});

	async function runDraftReviewLoop(ctx: ExtensionContext, ids: number[]): Promise<void> {
		const skippedIds: number[] = [];

		for (const id of ids) {
			let issue: IssueDetail;
			try {
				issue = await issueShowJson(pi, id);
			} catch (err) {
				ctx.ui.notify(`Failed to fetch draft #${id}: ${err}`, "error");
				skippedIds.push(id);
				continue;
			}

			let resolved = false;
			while (!resolved) {
				const action = await showScrollableMarkdown<"approve" | "edit" | "skip">(ctx, {
					title: `Review draft #${id} — ${issue.title}`,
					markdown: formatDraftForReview(issue),
					actions: [
						{ keyId: "return", label: "↵ approve", result: "approve" },
						{ keyId: "e", label: "e edit", result: "edit" },
						{ keyId: "escape", label: "esc skip", result: "skip" },
					],
				});

				if (action === "approve") {
					try {
						await issueDraftApprove(pi, id);
					} catch (err) {
						ctx.ui.notify(`Failed to approve draft #${id}: ${err}`, "error");
					}
					resolved = true;
				} else if (action === "skip") {
					skippedIds.push(id);
					resolved = true;
				} else {
					// edit: open editor with current content, loop until valid parse or cancel
					let parsed: { title: string; priority: string; description: string } | null = null;
					while (parsed === null) {
						const buffer = await ctx.ui.editor("Edit draft:", formatDraftForEdit(issue));
						if (buffer === undefined) {
							// User cancelled the editor — leave as draft
							skippedIds.push(id);
							resolved = true;
							break;
						}
						try {
							parsed = parseDraftEditBuffer(buffer);
						} catch (err) {
							ctx.ui.notify(`Invalid format: ${err instanceof Error ? err.message : String(err)}`, "error");
							// loop: re-open editor
						}
					}
					if (parsed !== null) {
						try {
							await issueUpdate(pi, id, {
								title: parsed.title,
								description: parsed.description,
								priority: parsed.priority,
							});
							issue = await issueShowJson(pi, id);
						} catch (err) {
							ctx.ui.notify(`Failed to update draft #${id}: ${err}`, "error");
							skippedIds.push(id);
							resolved = true;
						}
						// outer while continues: show the updated draft for approve/edit/skip
					}
				}
			}
		}

		if (skippedIds.length === 0) {
			ctx.ui.notify("All drafts approved.", "info");
			return;
		}

		const skippedList = skippedIds.map((id) => `#${id}`).join(", ");
		const feedback = await ctx.ui.editor(
			`${skippedIds.length} draft(s) left pending (${skippedList}). Instructions for the agent to rework them (leave blank to end):`,
			"",
		);
		if (feedback !== undefined && feedback.trim() !== "") {
			pi.sendUserMessage(feedback.trim());
		}
	}
}

function registerDesignerTools(pi: ExtensionAPI, getPendingDraftIds: () => number[]): void {
	pi.registerTool({
		name: "list_issues",
		label: "List Issues",
		description:
			"List existing issues with optional filters. Defaults to listing all open and draft issues. Use this to understand what already exists before proposing new issues.",
		parameters: Type.Object({
			status: Type.Optional(STATUS_SCHEMA),
			priority: Type.Optional(PRIORITY_SCHEMA),
			parent_id: Type.Optional(
				Type.Union([Type.Number(), Type.Null()], {
					description: "Filter by parent issue id; null lists only top-level issues",
				}),
			),
		}),
		async execute(_id, params) {
			const issues = await issueListFiltered(pi, {
				status: params.status,
				priority: params.priority,
				parent_id: params.parent_id,
			});
			if (issues.length === 0) {
				return { content: [{ type: "text" as const, text: "(no issues matched the filter)" }] };
			}
			const lines = issues.map(
				(i) =>
					`#${i.id} ${i.priority} ${i.status}${i.parent_id ? ` (subissue of #${i.parent_id})` : ""} — ${i.title}`,
			);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "show_issue",
		label: "Show Issue",
		description:
			"Fetch full detail for one issue: description, comments, subissues, and blockers. Use to read context before refining or linking.",
		parameters: Type.Object({
			id: Type.Number({ description: "Issue id" }),
		}),
		async execute(_id, params) {
			const issue = await issueShowJson(pi, params.id);
			return { content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }] };
		},
	});

	pi.registerTool({
		name: "draft_issue",
		label: "Queue Draft Issue",
		description:
			"Queue a new top-level issue as a draft for the operator to review. The operator will approve, edit, or defer it after this turn. Queue multiple drafts in one turn when the operator describes several related issues.",
		parameters: Type.Object({
			title: Type.String({ description: "Short, action-oriented title" }),
			description: Type.Optional(
				Type.String({ description: "Markdown describing the problem and what success looks like" }),
			),
			priority: PRIORITY_SCHEMA,
			block_on: Type.Optional(
				Type.Array(Type.Number(), {
					description: "Issue ids that must be resolved before this one can start",
				}),
			),
		}),
		async execute(_id, params) {
			const newId = await issueCreate(pi, {
				title: params.title,
				description: params.description,
				priority: params.priority,
				status: "draft",
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			getPendingDraftIds().push(newId);
			const blockMsg =
				params.block_on && params.block_on.length > 0
					? `, blocked by [${params.block_on.join(", ")}]`
					: "";
			return {
				content: [
					{ type: "text" as const, text: `Queued draft #${newId} (${params.priority})${blockMsg}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "draft_subissue",
		label: "Queue Draft Subissue",
		description:
			"Queue a new draft issue as a child of an existing parent. Use for tasks that are clearly part of a larger effort.",
		parameters: Type.Object({
			parent_id: Type.Number({ description: "Existing parent issue id" }),
			title: Type.String(),
			description: Type.Optional(Type.String()),
			priority: PRIORITY_SCHEMA,
			block_on: Type.Optional(Type.Array(Type.Number())),
		}),
		async execute(_id, params) {
			const newId = await issueCreate(pi, {
				title: params.title,
				description: params.description,
				priority: params.priority,
				parent_id: params.parent_id,
				status: "draft",
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			getPendingDraftIds().push(newId);
			return {
				content: [
					{
						type: "text" as const,
						text: `Queued draft subissue #${newId} under #${params.parent_id} (${params.priority})`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "update_issue",
		label: "Update Issue",
		description: "Refine an existing issue's title, description, or priority. Pass only the fields you want to change.",
		parameters: Type.Object({
			id: Type.Number(),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			priority: Type.Optional(PRIORITY_SCHEMA),
		}),
		async execute(_id, params) {
			await issueUpdate(pi, params.id, {
				title: params.title,
				description: params.description,
				priority: params.priority,
			});
			const changed: string[] = [];
			if (params.title !== undefined) changed.push("title");
			if (params.description !== undefined) changed.push("description");
			if (params.priority !== undefined) changed.push("priority");
			const summary = changed.length ? changed.join(", ") : "(no changes)";
			return { content: [{ type: "text" as const, text: `Updated #${params.id}: ${summary}` }] };
		},
	});

	pi.registerTool({
		name: "add_comment",
		label: "Add Comment",
		description: "Append a note comment to an existing issue. Use when context is worth recording but doesn't change the title/description.",
		parameters: Type.Object({
			id: Type.Number(),
			content: Type.String(),
		}),
		async execute(_id, params) {
			await issueComment(pi, params.id, "note", params.content);
			return { content: [{ type: "text" as const, text: `Comment added to #${params.id}` }] };
		},
	});

	pi.registerTool({
		name: "block",
		label: "Block",
		description: "Record that one open issue blocks another. The blocked issue will not be eligible for /bs-task auto-pick until the blocker closes.",
		parameters: Type.Object({
			blocked_id: Type.Number({ description: "The issue that is blocked" }),
			blocker_id: Type.Number({ description: "The issue that must close first" }),
		}),
		async execute(_id, params) {
			await dependencyAdd(pi, params.blocked_id, params.blocker_id);
			return {
				content: [
					{ type: "text" as const, text: `#${params.blocked_id} is now blocked by #${params.blocker_id}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "unblock",
		label: "Unblock",
		description: "Remove a block relationship between two issues.",
		parameters: Type.Object({
			blocked_id: Type.Number(),
			blocker_id: Type.Number(),
		}),
		async execute(_id, params) {
			await dependencyRemove(pi, params.blocked_id, params.blocker_id);
			return {
				content: [
					{ type: "text" as const, text: `Removed block: #${params.blocker_id} → #${params.blocked_id}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "reparent",
		label: "Reparent",
		description: "Set or clear an issue's parent. Pass parent_id=null to promote a subissue to top-level.",
		parameters: Type.Object({
			id: Type.Number(),
			parent_id: Type.Union([Type.Number(), Type.Null()]),
		}),
		async execute(_id, params) {
			await issueSetParent(pi, params.id, params.parent_id);
			const where = params.parent_id === null ? "top-level" : `child of #${params.parent_id}`;
			return { content: [{ type: "text" as const, text: `Issue #${params.id} is now ${where}` }] };
		},
	});

	pi.registerTool({
		name: "archive",
		label: "Archive",
		description: "Mark an issue as archived. Use when the operator decides not to pursue it — distinct from closing, which belongs to /bs-task.",
		parameters: Type.Object({
			id: Type.Number(),
		}),
		async execute(_id, params) {
			await issueArchive(pi, params.id);
			return { content: [{ type: "text" as const, text: `Archived #${params.id}` }] };
		},
	});
}
