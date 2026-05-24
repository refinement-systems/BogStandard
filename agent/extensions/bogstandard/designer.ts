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
 * Registers `/bs-design` and the Designer tool set. Conversational; not
 * coupled to the /bs-task phase machine. Creates issues as version-1 drafts
 * which the operator reviews after each turn; can also redraft an existing
 * issue (creates v2+, used to recover an `aborted` issue or revise a `ready`
 * one).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import {
	configureDb,
	dependencyAdd,
	dependencyRemove,
	getAgentId,
	issueArchive,
	issueCreate,
	issueListFiltered,
	issuePromoteToReady,
	issueSetParent,
	issueShowJson,
	issueUpdate,
	issueComment,
	recentPhaseEvents,
	redraftIssue,
	type IssueDetail,
	type Phase,
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
	"redraft_issue",
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

const PHASE_SCHEMA = Type.Union(
	[
		Type.Literal("drafting"),
		Type.Literal("ready"),
		Type.Literal("planning"),
		Type.Literal("implementing"),
		Type.Literal("red_planning"),
		Type.Literal("red_impl"),
		Type.Literal("green_planning"),
		Type.Literal("green_impl"),
		Type.Literal("done"),
		Type.Literal("aborted"),
		Type.Literal("archived"),
	],
	{ description: "Issue phase filter" },
);

export interface RegisterDesignerOptions {
	isTaskActive: () => boolean;
}

export function registerDesigner(pi: ExtensionAPI, opts: RegisterDesignerOptions): void {
	let designerActive = false;
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

			let readyIssues: Array<{ id: number; title: string; priority?: string; parent_id: number | null }> = [];
			let draftIssues: Array<{ id: number; title: string; priority?: string; parent_id: number | null }> = [];
			let abortedRaw: Array<{ id: number; title: string; priority?: string; parent_id: number | null }> = [];
			try {
				readyIssues = await issueListFiltered(pi, { phase: "ready" });
				draftIssues = await issueListFiltered(pi, { phase: "drafting" });
				abortedRaw = await issueListFiltered(pi, { phase: "aborted" });
			} catch (err) {
				ctx.ui.notify(`Failed to list issues: ${err}`, "error");
				return;
			}

			const abortedIssues: Array<{
				id: number;
				title: string;
				priority?: string;
				parent_id: number | null;
				aborted_reason?: string | null;
			}> = [];
			for (const ai of abortedRaw) {
				let reason: string | null = null;
				try {
					const events = await recentPhaseEvents(pi, ai.id, 5);
					const abortEv = events.find((e) => e.phase_to === "aborted");
					reason = abortEv?.reason ?? null;
				} catch {
					// non-fatal: just don't surface the reason
				}
				abortedIssues.push({ ...ai, aborted_reason: reason });
			}

			designerActive = true;
			pendingDraftIds = [];
			pi.setActiveTools(DESIGN_TOOLS);

			const kickoff = buildDesignerKickoffPrompt(readyIssues, draftIssues, abortedIssues);
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
		const agentId = await getAgentId(pi);

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
						await issuePromoteToReady(pi, id, agentId);
					} catch (err) {
						ctx.ui.notify(`Failed to approve draft #${id}: ${err}`, "error");
					}
					resolved = true;
				} else if (action === "skip") {
					skippedIds.push(id);
					resolved = true;
				} else {
					let parsed: { title: string; priority: string; needs_tests: boolean; description: string } | null = null;
					while (parsed === null) {
						const buffer = await ctx.ui.editor("Edit draft:", formatDraftForEdit(issue));
						if (buffer === undefined) {
							skippedIds.push(id);
							resolved = true;
							break;
						}
						try {
							parsed = parseDraftEditBuffer(buffer);
						} catch (err) {
							ctx.ui.notify(`Invalid format: ${err instanceof Error ? err.message : String(err)}`, "error");
						}
					}
					if (parsed !== null) {
						try {
							await issueUpdate(pi, id, {
								title: parsed.title,
								description: parsed.description,
								priority: parsed.priority,
								needs_tests: parsed.needs_tests,
							});
							issue = await issueShowJson(pi, id);
						} catch (err) {
							ctx.ui.notify(`Failed to update draft #${id}: ${err}`, "error");
							skippedIds.push(id);
							resolved = true;
						}
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
			"List existing issues with optional filters. Defaults to listing all drafting and ready issues. Use this to understand what already exists before proposing new issues. Pass phase='aborted' to see issues that need redrafting.",
		parameters: Type.Object({
			phase: Type.Optional(PHASE_SCHEMA),
			priority: Type.Optional(PRIORITY_SCHEMA),
			parent_id: Type.Optional(
				Type.Union([Type.Number(), Type.Null()], {
					description: "Filter by parent issue id; null lists only top-level issues",
				}),
			),
		}),
		async execute(_id, params) {
			const issues = await issueListFiltered(pi, {
				phase: params.phase as Phase | undefined,
				priority: params.priority,
				parent_id: params.parent_id,
			});
			if (issues.length === 0) {
				return { content: [{ type: "text" as const, text: "(no issues matched the filter)" }] };
			}
			const lines = issues.map(
				(i) =>
					`#${i.id} ${i.priority} ${i.phase}${i.parent_id ? ` (subissue of #${i.parent_id})` : ""} — ${i.title}`,
			);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "show_issue",
		label: "Show Issue",
		description:
			"Fetch full detail for one issue: current version's title/description/needs_tests, comments scoped to the current version, subissues, and blockers. Pass include_history=true to also fetch all prior versions and their comments — use this before redrafting.",
		parameters: Type.Object({
			id: Type.Number({ description: "Issue id" }),
			include_history: Type.Optional(
				Type.Boolean({ description: "Include all prior versions and their comments" }),
			),
		}),
		async execute(_id, params) {
			const issue = await issueShowJson(pi, params.id, { include_history: params.include_history === true });
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
			needs_tests: Type.Boolean({
				description:
					"True if this issue should be implemented via red/green TDD (write failing tests first). False for purely structural, cosmetic, or operational changes that don't warrant test-first.",
			}),
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
				needs_tests: params.needs_tests,
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			getPendingDraftIds().push(newId);
			const blockMsg =
				params.block_on && params.block_on.length > 0
					? `, blocked by [${params.block_on.join(", ")}]`
					: "";
			const testsMsg = params.needs_tests ? "TDD" : "no-tests";
			return {
				content: [
					{ type: "text" as const, text: `Queued draft #${newId} (${params.priority}, ${testsMsg})${blockMsg}` },
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
			needs_tests: Type.Boolean(),
			block_on: Type.Optional(Type.Array(Type.Number())),
		}),
		async execute(_id, params) {
			const newId = await issueCreate(pi, {
				title: params.title,
				description: params.description,
				priority: params.priority,
				parent_id: params.parent_id,
				needs_tests: params.needs_tests,
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			getPendingDraftIds().push(newId);
			const testsMsg = params.needs_tests ? "TDD" : "no-tests";
			return {
				content: [
					{
						type: "text" as const,
						text: `Queued draft subissue #${newId} under #${params.parent_id} (${params.priority}, ${testsMsg})`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "update_issue",
		label: "Update Issue",
		description:
			"Refine an existing issue. Title, description, and needs_tests can only be changed while the issue is in 'drafting' phase. Priority can be changed any time.",
		parameters: Type.Object({
			id: Type.Number(),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			priority: Type.Optional(PRIORITY_SCHEMA),
			needs_tests: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			await issueUpdate(pi, params.id, {
				title: params.title,
				description: params.description,
				priority: params.priority,
				needs_tests: params.needs_tests,
			});
			const changed: string[] = [];
			if (params.title !== undefined) changed.push("title");
			if (params.description !== undefined) changed.push("description");
			if (params.priority !== undefined) changed.push("priority");
			if (params.needs_tests !== undefined) changed.push("needs_tests");
			const summary = changed.length ? changed.join(", ") : "(no changes)";
			return { content: [{ type: "text" as const, text: `Updated #${params.id}: ${summary}` }] };
		},
	});

	pi.registerTool({
		name: "redraft_issue",
		label: "Redraft Issue",
		description:
			"Produce a new version of an existing issue. Allowed only when phase is drafting, ready, or aborted. Use this to recover an 'aborted' issue (the only way out of that state) or to substantially revise a 'ready' issue. The new version starts with a clean comment history; carry_forward_summary becomes the first comment on it. Read the prior version first with show_issue(id, include_history=true) so you can write an accurate summary.",
		parameters: Type.Object({
			id: Type.Number(),
			title: Type.String(),
			description: Type.String(),
			needs_tests: Type.Boolean(),
			carry_forward_summary: Type.String({
				description:
					"What was retained from the prior version, what was changed, and why. Becomes the first comment on the new version.",
			}),
		}),
		async execute(_id, params) {
			const agentId = await getAgentId(pi);
			const result = await redraftIssue(
				pi,
				params.id,
				{
					title: params.title,
					description: params.description,
					needs_tests: params.needs_tests,
					carry_forward_summary: params.carry_forward_summary,
				},
				agentId,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Redrafted #${params.id} as v${result.version_no}. Phase reset to 'ready'.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "add_comment",
		label: "Add Comment",
		description:
			"Append a note to an existing issue. The comment is scoped to the issue's current version — if the issue is later redrafted, this comment stays attached to the version it was written against.",
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
		description:
			"Record that one open issue blocks another. The blocked issue will not be eligible for /bs-task auto-pick until the blocker closes.",
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
			const agentId = await getAgentId(pi);
			await issueArchive(pi, params.id, agentId);
			return { content: [{ type: "text" as const, text: `Archived #${params.id}` }] };
		},
	});
}
