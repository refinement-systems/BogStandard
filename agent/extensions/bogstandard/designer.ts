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
	issueListFiltered,
	issueSetParent,
	issueShowJson,
	issueUpdate,
	issueComment,
} from "./db.js";
import { buildDesignerKickoffPrompt, buildDesignerSystemPrompt } from "./designer-prompts.js";

const DESIGN_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
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
];

const PRIORITY_SCHEMA = Type.Union(
	[Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")],
	{ description: "Priority: low, medium, high, or critical" },
);

const STATUS_SCHEMA = Type.Union(
	[Type.Literal("open"), Type.Literal("closed"), Type.Literal("archived")],
	{ description: "Issue status filter" },
);

export interface RegisterDesignerOptions {
	/**
	 * Returns true if the /bs-task state machine is mid-flow. The Designer
	 * refuses to run while a task is active to keep the active tool set sane.
	 */
	isTaskActive: () => boolean;
}

export function registerDesigner(pi: ExtensionAPI, opts: RegisterDesignerOptions): void {
	// Closure flag flipped on by /bs-design and consumed by before_agent_start
	// to swap in the Designer system prompt. Not persisted across sessions —
	// re-run /bs-design after `pi -r` to reactivate.
	let designerActive = false;

	registerDesignerTools(pi);

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
			try {
				openIssues = await issueListFiltered(pi, { status: "open" });
			} catch (err) {
				ctx.ui.notify(`Failed to list open issues: ${err}`, "error");
				return;
			}

			designerActive = true;
			pi.setActiveTools(DESIGN_TOOLS);

			const kickoff = buildDesignerKickoffPrompt(openIssues);
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
}

function registerDesignerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "list_issues",
		label: "List Issues",
		description:
			"List existing issues with optional filters. Defaults to listing all open issues. Use this to understand what already exists before proposing new issues.",
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
				status: params.status ?? "open",
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
		name: "create_issue",
		label: "Create Issue",
		description:
			"Create a new top-level open issue. Confirm the title, description, and priority with the operator before calling.",
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
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			const blockMsg =
				params.block_on && params.block_on.length > 0
					? `, blocked by [${params.block_on.join(", ")}]`
					: "";
			return {
				content: [
					{ type: "text" as const, text: `Created issue #${newId} (${params.priority})${blockMsg}` },
				],
			};
		},
	});

	pi.registerTool({
		name: "create_subissue",
		label: "Create Subissue",
		description:
			"Create a new open issue as a child of an existing parent. Use for tasks that are clearly part of a larger effort.",
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
			});
			for (const blockerId of params.block_on ?? []) {
				await dependencyAdd(pi, newId, blockerId);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Created subissue #${newId} under #${params.parent_id} (${params.priority})`,
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
