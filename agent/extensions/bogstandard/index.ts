/**
 * BogStandard — plan & implement issues end-to-end from pi.
 *
 * Two paths share one command and one state machine:
 *
 *   /bs-task [issue]
 *     -> pick issue + review-and-comment loop
 *     -> "Does this issue need tests?"
 *          -> no  : no-tests path
 *                   planning -> reviewing-plan -> implementing -> done
 *          -> yes : TDD path (requires a clean working tree)
 *                   planning-red -> reviewing-red-plan -> implementing-red
 *                   -> commit "Testing phase: red", capture diff
 *                   -> planning-green -> reviewing-green-plan
 *                   -> implementing-green
 *                       -> success: close + commit
 *                       -> bail   : comment + git reset --hard HEAD~1
 *                                   -> restart at planning-red
 *
 * Planning phases emit their plan via the `save_plan` tool (terminate: true).
 * Green-phase implementation can call `bail_out` to abort the cycle.
 *
 * Phase state is persisted via `pi.appendEntry("bs-task-phase", ...)` so
 * `pi -r` resumes from where we left off.
 *
 * The Designer stage (`/bs-design`) lives in `./designer.ts`; it runs as a
 * separate, conversational command and does not participate in this state
 * machine.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildIssueDisplay,
	configureDb,
	getAgentId,
	isLockStale,
	type IssueDetail,
	type IssueListEntry,
	type LockEntry,
	issueClose,
	issueComment,
	issueShowJson,
	locksClaim,
	locksList,
	locksRelease,
	locksSteal,
} from "./db.js";
import { loadConfig } from "./config.js";
import { addAll, commit, currentBranch, hasStagedChanges, headShortSha, isClean, resetHardHeadMinus1, showHeadDiff } from "./git.js";
import { formatIssueLabel, listEligible, pickFirstEligible } from "./issue-picker.js";
import { type BogstandardState, type Phase, buildBsHeader, endReason, loadState, parseBsHeader, reconstructState, saveState } from "./phases.js";
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
} from "./prompts.js";
import { registerQuestionnaireTool } from "./questionnaire.js";
import { registerDesigner } from "./designer.js";
import { showScrollableMarkdown } from "./scrollable-markdown.js";

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "questionnaire", "save_plan"];
const IMPL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const GREEN_IMPL_TOOLS = [...IMPL_TOOLS, "bail_out"];

/**
 * Map a planning phase to its corresponding "plan review" phase.
 * `save_plan` calls this so the same tool transitions correctly whether the
 * caller is the no-tests, red, or green planner.
 */
function planningToReviewPhase(phase: Phase): Phase {
	if (phase === "planning") return "reviewing-plan";
	if (phase === "planning-red") return "reviewing-red-plan";
	if (phase === "planning-green") return "reviewing-green-plan";
	// Defensive: save_plan was called outside a planning phase. Leave state
	// untouched so the operator can investigate via /tree or pi -r.
	return phase;
}

export default function bogstandard(pi: ExtensionAPI) {
	let state: BogstandardState = { phase: "idle" };
	// Working copy of the picked issue; re-fetched on session restore.
	let issue: IssueDetail | undefined;

	function persist(): void {
		saveState(pi, state);
	}

	function reset(): void {
		state = { phase: "idle" };
		issue = undefined;
		persist();
	}

	registerQuestionnaireTool(pi);

	registerDesigner(pi, {
		isTaskActive: () => state.phase !== "idle" && state.phase !== "done",
	});

	// Per-phase model selection flags. The broad ones apply to every planner
	// or implementer phase; the per-sub-phase overrides take precedence when
	// set. All values take pi's standard `provider/id` form, e.g.
	// `anthropic/claude-sonnet-4-6`.
	pi.registerFlag("bs-plan-model", {
		description: "Model for all planner phases (provider/id). Overridden by per-sub-phase flags.",
		type: "string",
	});
	pi.registerFlag("bs-impl-model", {
		description: "Model for all implementer phases (provider/id). Overridden by per-sub-phase flags.",
		type: "string",
	});
	pi.registerFlag("bs-red-plan-model", {
		description: "Model for the TDD red-phase planner (provider/id). Overrides --bs-plan-model.",
		type: "string",
	});
	pi.registerFlag("bs-red-impl-model", {
		description: "Model for the TDD red-phase implementer (provider/id). Overrides --bs-impl-model.",
		type: "string",
	});
	pi.registerFlag("bs-green-plan-model", {
		description: "Model for the TDD green-phase planner (provider/id). Overrides --bs-plan-model.",
		type: "string",
	});
	pi.registerFlag("bs-green-impl-model", {
		description: "Model for the TDD green-phase implementer (provider/id). Overrides --bs-impl-model.",
		type: "string",
	});
	pi.registerFlag("bs-issue-id", {
		description:
			"Issue ID to work on (set by dispatch.sh to pre-assign workers; skips auto-pick). For interactive use, type '/bs-task <id>' in the prompt instead.",
		type: "string",
	});
	pi.registerFlag("bs-database-url", {
		description:
			"Postgres connection string (overrides BOGSTANDARD_DATABASE_URL and .bogstandard/config.json).",
		type: "string",
	});
	pi.registerFlag("bs-agent-id", {
		description:
			"Agent id used for lock ownership (overrides BOGSTANDARD_AGENT_ID and .bogstandard/config.json). Distinct ids let multiple workers hold distinct locks against the same database.",
		type: "string",
	});
	pi.registerFlag("bs-recover", {
		description: "Force recovery from postgres comment history, even if local state exists.",
		type: "boolean",
	});
	pi.registerFlag("bs-debug", {
		description: "Print the system prompt and user prompt before each agent phase starts.",
		type: "boolean",
	});

	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description:
			"Save the final implementation plan and end the planning phase. Call exactly once, after Phase 3 finalization. After this returns, stop calling tools.",
		parameters: Type.Object({
			plan: Type.String({ description: "The complete plan markdown" }),
		}),
		async execute(_id, params) {
			state.plan = params.plan;
			state.phase = planningToReviewPhase(state.phase);
			persist();
			return {
				content: [
					{
						type: "text",
						text: "Plan saved. Stop now — do not call any more tools.",
					},
				],
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "bail_out",
		label: "Bail Out",
		description:
			"Signal that the red-phase tests are fundamentally unsolvable (wrong semantics, impossible contract, nonexistent API) without modifying the tests. Call this with a precise diagnosis, then stop immediately. Only available during green-phase implementation.",
		parameters: Type.Object({
			reason: Type.String({
				description: "Diagnosis of why the tests cannot be made to pass without modifying them",
			}),
		}),
		async execute(_id, params) {
			state.bailReason = params.reason;
			persist();
			return {
				content: [
					{
						type: "text",
						text: "Bail recorded. Stop now — do not call any more tools. Send your final diagnosis message and end.",
					},
				],
				terminate: true,
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		const phase = state.phase;
		if (
			phase === "planning" ||
			phase === "planning-red" ||
			phase === "planning-green" ||
			phase === "implementing" ||
			phase === "implementing-red" ||
			phase === "implementing-green"
		) {
			return { systemPrompt: buildPhaseSystemPrompt(phase, event.systemPrompt) };
		}
		return undefined;
	});

	pi.registerCommand("bs-task", {
		description: "Plan & implement the next eligible issue (or the one whose id you pass)",
		getArgumentCompletions: async (prefix) => {
			try {
				const eligible = await listEligible(pi);
				const matching = eligible.filter((i) => String(i.id).startsWith(prefix));
				if (matching.length === 0) return null;
				return matching.map((i) => ({
					value: String(i.id),
					label: formatIssueLabel(i),
				}));
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			if (state.phase !== "idle" && state.phase !== "done") {
				if (
					state.phase === "implementing" ||
					state.phase === "implementing-red" ||
					state.phase === "implementing-green"
				) {
					await handleImplementationEnd(ctx, false);
					return;
				}
				ctx.ui.notify(
					`/bs-task is already running (phase: ${state.phase}). Resolve or /new to start over.`,
					"warning",
				);
				return;
			}

			// Resolve which issue to work on.
			// --bs-issue-id takes precedence over the positional arg; dispatch.sh
			// uses it because pi's CLI parser treats positional tokens after the
			// command name as separate messages, not as command args.
			let picked: IssueListEntry | undefined;
			const flagIssueId = pi.getFlag("bs-issue-id") as string | undefined;
			const arg = flagIssueId ?? args.trim();
			if (arg !== "") {
				const id = Number.parseInt(arg, 10);
				if (Number.isNaN(id)) {
					ctx.ui.notify(`Invalid issue id: ${arg}`, "error");
					return;
				}
				picked = { id, title: "", status: "open" };
			} else {
				try {
					picked = await pickFirstEligible(pi);
				} catch (err) {
					ctx.ui.notify(`Failed to query issues: ${err}`, "error");
					return;
				}
				if (!picked) {
					ctx.ui.notify("No eligible open issues found.", "warning");
					return;
				}
			}

			try {
				issue = await issueShowJson(pi, picked.id);
			} catch (err) {
				ctx.ui.notify(`Failed to fetch issue #${picked.id}: ${err}`, "error");
				return;
			}

			const bsRecover = pi.getFlag("bs-recover") as boolean | undefined;
			if (bsRecover || (state.phase === "idle" && hasBsEvents(issue))) {
				const doRecover =
					bsRecover ||
					(await ctx.ui.confirm(
						`Found an in-flight BogStandard run on issue #${issue.id} — recover from comment history?`,
						"State will be rebuilt from the issue's comment log. The working tree is left as-is.",
					));
				if (doRecover) {
					const gitShowFn = async (sha: string): Promise<string> => {
						const result = await pi.exec("git", ["show", sha, "--stat", "--patch", "--no-color"]);
						return result.stdout;
					};
					state = await reconstructState(issue, gitShowFn);
					persist();
					// Claim the lock during recovery if we don't already hold it.
					const recoveryAgentId = await getAgentId(pi);
					if (recoveryAgentId) {
						const lf = await locksList(pi);
						const hasOurLock = lf?.locks[String(issue.id)]?.agent_id === recoveryAgentId;
						if (!hasOurLock) {
							try {
								await locksClaim(pi, issue.id, await currentBranch(pi));
							} catch (err) {
								ctx.ui.notify(`Recovery: could not claim lock: ${err}`, "warning");
							}
						}
					}
					await routeRecoveredState(ctx);
					return;
				}
			}

			// Check for a foreign lock before the review loop.
			const lockResult = await checkAndHandleLock(ctx, issue.id);
			if (lockResult === "abort") return;

			const confirmed = await runIssueReviewLoop(pi, ctx);
			if (!confirmed || !issue) {
				return;
			}

			// Claim the lock now that the user has confirmed this issue.
			const claimAgentId = await getAgentId(pi);
			if (claimAgentId) {
				try {
					await locksClaim(pi, issue.id, await currentBranch(pi));
				} catch (err) {
					ctx.ui.notify(`Could not claim lock on issue #${issue.id}: ${err}`, "error");
					return;
				}
			}

			// Choose between TDD and direct-implementation paths.
			const needsTests = await ctx.ui.confirm(
				"Choose an implementation path",
				"Red-Green TDD: write failing tests first, commit, then make them pass. Implement directly: single plan + implementation, agent follows the issue as written.",
			);

			await postDurableComment(
				ctx,
				"decision",
				"path-chosen",
				{ path: needsTests ? "tdd" : "no-tests" },
				needsTests ? "Path chosen: TDD (red/green cycle)" : "Path chosen: implement directly (single plan + implement)",
			);

			if (needsTests) {
				try {
					const clean = await isClean(pi);
					if (!clean) {
						await locksRelease(pi, issue.id);
						ctx.ui.notify(
							"TDD path requires a clean working tree. Stash or commit your changes, then re-run /bs-task.",
							"error",
						);
						return;
					}
				} catch (err) {
					ctx.ui.notify(`Failed to check git status: ${err}`, "error");
					return;
				}

				state = { phase: "planning-red", issueId: issue.id };
				persist();
				await kickoffPhase(
					ctx,
					"planning-red",
					"bs-task-red-plan-prompt",
					buildRedPlanPrompt(issue),
					PLAN_TOOLS,
				);
				return;
			}

			// Implement directly path.
			state = { phase: "planning", issueId: issue.id };
			persist();
			await kickoffPhase(
				ctx,
				"planning",
				"bs-task-plan-prompt",
				buildPlanPrompt(issue),
				PLAN_TOOLS,
			);
		},
	});

	/**
	 * Shown when another agent holds the lock on the picked issue.
	 * Returns the operator's decision.
	 */
	async function handleForeignLock(
		ctx: ExtensionContext,
		issueId: number,
		lock: LockEntry,
		stale: boolean,
	): Promise<"steal" | "pick-other" | "abort"> {
		const ageMin = Math.round((Date.now() - new Date(lock.claimed_at).getTime()) / 60000);
		const staleTag = stale ? " [STALE]" : "";
		ctx.ui.notify(
			`Issue #${issueId} is locked by '${lock.agent_id}' (${ageMin} min ago)${staleTag}`,
			"warning",
		);
		const choice = await ctx.ui.select("How would you like to proceed?", [
			"Pick a different issue",
			"Steal the lock",
			"Abort",
		]);
		if (!choice || choice === "Abort") return "abort";
		if (choice.startsWith("Steal")) return "steal";
		return "pick-other";
	}

	/**
	 * Check for a foreign lock on the issue and let the operator decide how
	 * to handle it. Call this after the issue is fetched, before the review
	 * loop. Returns "ok" to continue or "abort" to exit the command.
	 *
	 * Gracefully degrades: if agent is not configured or the coordination
	 * branch is unreachable, returns "ok" and proceeds without lock management.
	 */
	async function checkAndHandleLock(
		ctx: ExtensionContext,
		issueId: number,
	): Promise<"ok" | "abort"> {
		const myAgentId = await getAgentId(pi);
		if (!myAgentId) return "ok"; // locks not configured — skip

		const locksFile = await locksList(pi);
		if (!locksFile) return "ok"; // coordination branch unreachable — skip

		const lockEntry = locksFile.locks[String(issueId)];
		if (!lockEntry) return "ok"; // not locked
		if (lockEntry.agent_id === myAgentId) return "ok"; // our lock — proceed

		const stale = isLockStale(lockEntry, locksFile.settings.stale_lock_timeout_minutes);
		const decision = await handleForeignLock(ctx, issueId, lockEntry, stale);

		if (decision === "abort") {
			ctx.ui.notify("Aborted.", "info");
			return "abort";
		}
		if (decision === "pick-other") {
			ctx.ui.notify("Re-run /bs-task to pick a different issue.", "info");
			return "abort";
		}
		// Steal
		try {
			await locksSteal(pi, issueId);
			ctx.ui.notify(`Stole lock on issue #${issueId}.`, "info");
			return "ok";
		} catch (err) {
			ctx.ui.notify(`Failed to steal lock: ${err}`, "error");
			return "abort";
		}
	}

	/**
	 * Issue review / comment / swap loop. Runs until the user confirms,
	 * aborts, or fails to pick something. Mutates the outer `issue` variable
	 * as the user comments or swaps issues.
	 */
	async function runIssueReviewLoop(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
		while (issue) {
			const action = await showScrollableMarkdown<"continue" | "comment" | "show" | "abort">(ctx, {
				title: `Issue #${issue.id} — ${formatIssueLabel(issue)}`,
				markdown: buildIssueDisplay(issue),
				actions: [
					{ keyId: "return", label: "↵ continue", result: "continue" },
					{ keyId: "c", label: "c comment", result: "comment" },
					{ keyId: "s", label: "s show others", result: "show" },
					{ keyId: "escape", label: "esc abort", result: "abort" },
				],
			});

			if (action === "abort") {
				if (issue) await locksRelease(pi, issue.id);
				ctx.ui.notify("Aborted before planning.", "info");
				return false;
			}

			if (action === "comment") {
				const body = await ctx.ui.editor("Comment:", "");
				if (body !== undefined && body.trim() !== "") {
					try {
						await issueComment(pi, issue.id, "human", body);
						issue = await issueShowJson(pi, issue.id);
					} catch (err) {
						ctx.ui.notify(`Failed to post comment: ${err}`, "error");
					}
				}
				continue;
			}

			if (action === "show") {
				let eligible: IssueListEntry[];
				try {
					eligible = await listEligible(pi);
				} catch (err) {
					ctx.ui.notify(`Failed to query issues: ${err}`, "error");
					continue;
				}
				if (eligible.length === 0) {
					ctx.ui.notify("No other eligible open issues.", "info");
					continue;
				}
				const labels = eligible.map((i) => formatIssueLabel(i));
				const chosen = await ctx.ui.select("Pick an issue:", labels);
				if (chosen) {
					const idx = labels.indexOf(chosen);
					if (idx >= 0) {
						try {
							issue = await issueShowJson(pi, eligible[idx].id);
						} catch (err) {
							ctx.ui.notify(`Failed to fetch issue: ${err}`, "error");
						}
					}
				}
				continue;
			}

			// action === "continue"
			return true;
		}
		return false;
	}

	pi.on("agent_end", async (event, ctx) => {
		if (!issue) return;

		try {
			const reason = endReason(event, state);
			if (reason === "interrupted") {
				await handleInterrupt(ctx);
				return;
			}
			switch (state.phase) {
				case "reviewing-plan":
					if (state.plan) await handleNoTestsPlanReview(ctx);
					return;
				case "implementing":
				case "implementing-red":
				case "implementing-green":
					await handleImplementationEnd(ctx, false);
					return;
				case "reviewing-red-plan":
					if (state.plan) await handleRedPlanReview(ctx);
					return;
				case "reviewing-green-plan":
					if (state.plan) await handleGreenPlanReview(ctx);
					return;
			}
		} catch (err) {
			// Surface unexpected failures rather than silently leaving the state
			// machine stuck; user can then re-invoke /bs-task or pi -r.
			ctx.ui.notify(`/bs-task: ${err}`, "error");
		}
	});

	/**
	 * Shared plan-review UI. Renders the current `state.plan` as scrollable
	 * markdown; Enter accepts (handing off to `onAccept`), Escape drops to
	 * a small refine/abort select.
	 */
	async function reviewPlanUI(
		ctx: ExtensionContext,
		options: {
			refinePhase: Phase;
			onAccept: (acceptedPlan: string) => Promise<void>;
		},
	): Promise<void> {
		if (!issue || !state.plan) return;

		const action = await showScrollableMarkdown<"accept" | "escape">(ctx, {
			title: `Plan for issue #${issue.id}`,
			markdown: state.plan,
			actions: [
				{ keyId: "return", label: "↵ accept", result: "accept" },
				{ keyId: "escape", label: "esc refine / abort", result: "escape" },
			],
		});

		if (action === "accept") {
			await options.onAccept(state.plan);
			return;
		}

		// Refine or abort.
		const choice = await ctx.ui.select("Plan not accepted — what next?", [
			"Send instructions to the planner",
			"Abort",
		]);

		if (!choice || choice === "Abort") {
			reset();
			ctx.ui.notify("Aborted after planning.", "info");
			return;
		}

		const refinement = await ctx.ui.editor("Instructions for the planner:", "");
		if (refinement === undefined || refinement.trim() === "") {
			ctx.ui.notify("No refinement entered; plan review left pending.", "info");
			return;
		}
		await postDurableComment(ctx, "decision", "plan-refine-instructions", { phase: options.refinePhase }, refinement.trim());
		state.phase = options.refinePhase;
		persist();
		pi.sendUserMessage(refinement.trim());
	}

	async function postDurableComment(
		ctx: ExtensionContext,
		kind: import("./db.js").CommentKind,
		event: string,
		attrs: Record<string, string> = {},
		body = "",
	): Promise<void> {
		if (!issue) return;
		const header = buildBsHeader(event, attrs);
		const text = body ? `${header}\n\n${body}` : header;
		try {
			await issueComment(pi, issue.id, kind, text);
		} catch (err) {
			ctx.ui.notify(`Failed to post durable event (${event}): ${err}`, "error");
		}
	}

	async function postPlanComment(
		ctx: ExtensionContext,
		planningPhase: "planning" | "planning-red" | "planning-green",
		plan: string,
	): Promise<void> {
		await postDurableComment(ctx, "plan", "plan-accepted", { phase: planningPhase }, plan);
	}

	/**
	 * Resolve which model to use for the given phase, following the flag
	 * precedence: per-sub-phase override > broad plan/impl flag > undefined
	 * (no switch).
	 */
	function resolveModelFor(phase: Phase): string | undefined {
		const broadPlan = pi.getFlag("bs-plan-model") as string | undefined;
		const broadImpl = pi.getFlag("bs-impl-model") as string | undefined;
		const get = (name: string) => pi.getFlag(name) as string | undefined;
		switch (phase) {
			case "planning":
				return broadPlan;
			case "implementing":
				return broadImpl;
			case "planning-red":
				return get("bs-red-plan-model") ?? broadPlan;
			case "implementing-red":
				return get("bs-red-impl-model") ?? broadImpl;
			case "planning-green":
				return get("bs-green-plan-model") ?? broadPlan;
			case "implementing-green":
				return get("bs-green-impl-model") ?? broadImpl;
			default:
				return undefined;
		}
	}

	/**
	 * Switch pi's active model for the given phase if a flag-resolved spec
	 * exists. Errors (bad spec, unknown model, missing API key) are surfaced
	 * via notification but do not block the phase transition — the user can
	 * /model into something appropriate and pi -r will pick up.
	 */
	async function switchModelForPhase(ctx: ExtensionContext, phase: Phase): Promise<void> {
		const spec = resolveModelFor(phase);
		if (!spec) return;

		const slash = spec.indexOf("/");
		if (slash < 0) {
			ctx.ui.notify(`Invalid /bs-task model spec '${spec}' — expected provider/id.`, "error");
			return;
		}
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);

		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			ctx.ui.notify(`/bs-task: model not found: ${spec}`, "error");
			return;
		}

		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`/bs-task: no API key configured for ${spec}`, "error");
		}
	}

	function buildPhaseSystemPrompt(phase: Phase, base: string): string {
		switch (phase) {
			case "planning":
			case "planning-red":
			case "planning-green":
				return buildPlannerSystemPrompt();
			case "implementing":
			case "implementing-red":
				return buildImplementerSystemPrompt();
			case "implementing-green":
				return buildGreenImplementerSystemPrompt();
			default:
				return base;
		}
	}

	function customTypeForPhase(phase: Phase): string {
		switch (phase) {
			case "planning":           return "bs-task-plan-prompt";
			case "planning-red":       return "bs-task-red-plan-prompt";
			case "planning-green":     return "bs-task-green-plan-prompt";
			case "implementing":       return "bs-task-impl-prompt";
			case "implementing-red":   return "bs-task-red-impl-prompt";
			case "implementing-green": return "bs-task-green-impl-prompt";
			default:                   return "bs-task-prompt";
		}
	}

	async function kickoffPhase(
		ctx: ExtensionContext,
		phase: Phase,
		customType: string,
		content: string,
		tools: string[],
	): Promise<void> {
		state.lastPrompt = content;
		persist();
		await switchModelForPhase(ctx, phase);
		pi.setActiveTools(tools);
		if (pi.getFlag("bs-debug")) {
			const systemPrompt = buildPhaseSystemPrompt(phase, "");
			pi.sendMessage(
				{ content: `**[bs-task-debug] ${phase} — system prompt**\n\n${systemPrompt}`, display: true },
				{ triggerTurn: false },
			);
			pi.sendMessage(
				{ content: `**[bs-task-debug] ${phase} — user prompt**\n\n${content}`, display: true },
				{ triggerTurn: false },
			);
		}
		pi.sendMessage({ customType, content, display: false }, { triggerTurn: true, deliverAs: "followUp" });
	}

	async function handleInterrupt(ctx: ExtensionContext): Promise<void> {
		const phase = state.phase;

		if (phase === "implementing" || phase === "implementing-red" || phase === "implementing-green") {
			await handleImplementationEnd(ctx, true);
			return;
		}

		if (phase.startsWith("planning")) {
			const choice = await ctx.ui.select("Phase interrupted — what next?", [
				"Continue (resume planner)",
				"Abort",
			]);
			if (!choice || choice === "Abort") {
				reset();
				ctx.ui.notify("Aborted. Issue left open.", "info");
				return;
			}
			const correction = await ctx.ui.editor("Correction for the planner (leave blank to resume):", "");
			if (correction === undefined) {
				reset();
				ctx.ui.notify("Aborted. Issue left open.", "info");
				return;
			}
			if (correction.trim()) {
				await postDurableComment(ctx, "decision", "interrupt-resolved", { choice: "continue" }, correction.trim());
				pi.sendUserMessage(correction.trim());
				return;
			}
			await postDurableComment(ctx, "decision", "interrupt-resolved", { choice: "continue" });
			if (!state.lastPrompt) {
				ctx.ui.notify("No saved prompt to resume from. Re-run /bs-task.", "error");
				return;
			}
			const tools = activeToolsForPhase(phase)!;
			await kickoffPhase(ctx, phase, customTypeForPhase(phase), state.lastPrompt, tools);
			return;
		}

		// reviewing-* or unexpected phase: treat as abort
		reset();
		ctx.ui.notify("Unexpected interrupt during review phase; state reset.", "warning");
	}

	async function handleImplementationEnd(
		ctx: ExtensionContext,
		isInterrupted: boolean,
	): Promise<void> {
		if (!issue) return;
		const phase = state.phase;

		const doneLabel =
			phase === "implementing-red"
				? "Done (proceed to green phase)"
				: "Done (close and commit)";

		const choice = await ctx.ui.select(
			isInterrupted ? "Phase interrupted — what next?" : "Implementation complete — what next?",
			[
				doneLabel,
				"Not done (continue working)",
				"Not done, quitting (commit incomplete work, leave issue open)",
			],
		);

		if (!choice || choice.startsWith("Done")) {
			if (isInterrupted) {
				await postDurableComment(ctx, "decision", "interrupt-resolved", { choice: "close-commit" });
			}
			if (phase === "implementing") {
				await closeAndCommit(ctx, issue);
			} else if (phase === "implementing-red") {
				await finalizeRedImplementation(ctx);
			} else {
				if (state.bailReason !== undefined) await handleBail(ctx);
				else await closeAndCommit(ctx, issue);
			}
			return;
		}

		if (choice.startsWith("Not done (continue")) {
			const defaultPrompt = isInterrupted ? (state.lastPrompt ?? "") : "";
			const userInput = await ctx.ui.editor("Message to the agent:", defaultPrompt);
			if (userInput === undefined) {
				reset();
				ctx.ui.notify("Aborted. Issue left open.", "info");
				return;
			}
			let prompt = userInput.trim() || defaultPrompt;
			if (!prompt) {
				// Rebuild from issue + state (recovery path: lastPrompt was lost with the session).
				if (phase === "implementing" && state.plan) {
					prompt = buildImplementPrompt(issue, state.plan);
				} else if (phase === "implementing-red" && state.plan) {
					prompt = buildRedImplementPrompt(issue, state.plan);
				} else if (phase === "implementing-green" && state.plan && state.redDiff) {
					prompt = buildGreenImplementPrompt(issue, state.plan, state.redDiff);
				} else {
					prompt = "Continue working on the implementation.";
				}
			}
			if (isInterrupted) {
				const body = userInput.trim() || "(no additional instructions)";
				await postDurableComment(ctx, "decision", "interrupt-resolved", { choice: "continue" }, body);
			}
			const tools = activeToolsForPhase(phase)!;
			await kickoffPhase(ctx, phase, customTypeForPhase(phase), prompt, tools);
			return;
		}

		// Not done, quitting
		if (isInterrupted) {
			await postDurableComment(ctx, "decision", "interrupt-resolved", { choice: "abort" });
		}
		const comment = await ctx.ui.editor(
			"Comment for the issue (leave blank to skip):",
			"",
		);
		if (comment !== undefined && comment.trim()) {
			try {
				await issueComment(pi, issue.id, "human", comment.trim());
			} catch (err) {
				ctx.ui.notify(`Failed to post comment: ${err}`, "warning");
			}
		}

		try {
			await addAll(pi);
			await commit(
				pi,
				`[WIP] ${issue.title}`,
				"Work in progress — session ended without completing issue.",
			);
		} catch (err) {
			ctx.ui.notify(`Failed to commit incomplete work: ${err}`, "warning");
		}

		reset();
		ctx.ui.notify(`Issue #${issue.id} left open. Incomplete work committed.`, "info");
	}

	// === No-tests path ===

	async function handleNoTestsPlanReview(ctx: ExtensionContext): Promise<void> {
		await reviewPlanUI(ctx, {
			refinePhase: "planning",
			onAccept: async (plan) => {
				if (!issue) return;
				await postPlanComment(ctx, "planning", plan);
				state.phase = "implementing";
				persist();
				await kickoffPhase(
					ctx,
					"implementing",
					"bs-task-impl-prompt",
					buildImplementPrompt(issue, plan),
					IMPL_TOOLS,
				);
			},
		});
	}

	// === Red phase (TDD) ===

	async function handleRedPlanReview(ctx: ExtensionContext): Promise<void> {
		await reviewPlanUI(ctx, {
			refinePhase: "planning-red",
			onAccept: async (plan) => {
				if (!issue) return;
				await postPlanComment(ctx, "planning-red", plan);
				state.phase = "implementing-red";
				persist();
				await kickoffPhase(
					ctx,
					"implementing-red",
					"bs-task-red-impl-prompt",
					buildRedImplementPrompt(issue, plan),
					IMPL_TOOLS,
				);
			},
		});
	}

	async function finalizeRedImplementation(ctx: ExtensionContext): Promise<void> {
		if (!issue) return;

		try {
			await addAll(pi);
		} catch (err) {
			ctx.ui.notify(`Failed to stage red changes: ${err}`, "error");
			return;
		}

		const hasChanges = await hasStagedChanges(pi);
		if (!hasChanges) {
			ctx.ui.notify(
				"Red phase produced no changes. The implementer was supposed to write failing tests. Use /bs-task to retry or pi -r to resume.",
				"error",
			);
			// Leave phase at implementing-red so resume picks up.
			return;
		}

		try {
			await commit(pi, issue.title, "Testing phase: red");
		} catch (err) {
			ctx.ui.notify(`Failed to commit red phase: ${err}`, "error");
			return;
		}

		let sha = "unknown";
		try {
			sha = await headShortSha(pi);
		} catch {
			// non-fatal: SHA is best-effort
		}
		await postDurableComment(ctx, "result", "red-commit", { sha }, `Red phase committed at ${sha}`);

		let diff: string;
		try {
			diff = await showHeadDiff(pi);
		} catch (err) {
			ctx.ui.notify(`Failed to capture red diff: ${err}`, "error");
			return;
		}

		// Hand off to the green planner.
		state.plan = undefined;
		state.redDiff = diff;
		state.phase = "planning-green";
		persist();
		await kickoffPhase(
			ctx,
			"planning-green",
			"bs-task-green-plan-prompt",
			buildGreenPlanPrompt(issue, diff),
			PLAN_TOOLS,
		);
	}

	// === Green phase (TDD) ===

	async function handleGreenPlanReview(ctx: ExtensionContext): Promise<void> {
		await reviewPlanUI(ctx, {
			refinePhase: "planning-green",
			onAccept: async (plan) => {
				if (!issue || !state.redDiff) return;
				await postPlanComment(ctx, "planning-green", plan);
				state.phase = "implementing-green";
				persist();
				await kickoffPhase(
					ctx,
					"implementing-green",
					"bs-task-green-impl-prompt",
					buildGreenImplementPrompt(issue, plan, state.redDiff),
					GREEN_IMPL_TOOLS,
				);
			},
		});
	}

	async function handleBail(ctx: ExtensionContext): Promise<void> {
		if (!issue || state.bailReason === undefined) return;
		const reason = state.bailReason;

		await postDurableComment(ctx, "blocker", "green-bail", {}, reason);

		const addComment = await ctx.ui.confirm(
			"Bail recorded. Add a comment before restarting the red phase?",
			reason,
		);
		if (addComment) {
			const body = await ctx.ui.editor("Comment:", "");
			if (body !== undefined && body.trim() !== "") {
				try {
					await issueComment(pi, issue.id, "human", body);
				} catch (err) {
					ctx.ui.notify(`Failed to post comment: ${err}`, "error");
				}
			}
		}

		try {
			await resetHardHeadMinus1(pi);
		} catch (err) {
			ctx.ui.notify(
				`Failed to roll back red commit: ${err}. Manual git recovery needed before retrying.`,
				"error",
			);
			return;
		}

		// Reset TDD-specific state, keep the same issue.
		state.plan = undefined;
		state.redDiff = undefined;
		state.bailReason = undefined;
		state.phase = "planning-red";
		persist();

		// Refetch the issue so the next red plan sees the bail diagnosis + any
		// human comment the operator just added.
		try {
			issue = await issueShowJson(pi, issue.id);
		} catch (err) {
			ctx.ui.notify(`Failed to refetch issue after bail: ${err}`, "error");
			return;
		}

		ctx.ui.notify("Bail handled. Restarting red phase with updated context.", "info");
		await kickoffPhase(
			ctx,
			"planning-red",
			"bs-task-red-plan-prompt",
			buildRedPlanPrompt(issue),
			PLAN_TOOLS,
		);
	}

	// === Shared close + commit ===

	async function closeAndCommit(ctx: ExtensionContext, currentIssue: IssueDetail): Promise<void> {
		try {
			await issueClose(pi, currentIssue.id);
		} catch (err) {
			ctx.ui.notify(`Failed to close issue: ${err}`, "error");
			return;
		}
		await locksRelease(pi, currentIssue.id);
		await postDurableComment(ctx, "resolution", "closed", {}, `Issue #${currentIssue.id} closed.`);

		try {
			await addAll(pi);
			const description = buildIssueDisplay(currentIssue);
			await commit(
				pi,
				currentIssue.title,
				description.trim() !== "" ? description : undefined,
			);
		} catch (err) {
			ctx.ui.notify(`Failed to commit: ${err}`, "error");
			return;
		}

		let sha = "unknown";
		try {
			sha = await headShortSha(pi);
		} catch {
			// non-fatal
		}
		await postDurableComment(ctx, "result", "final-commit", { sha }, `Final commit at ${sha}`);

		ctx.ui.notify(`Issue #${currentIssue.id} closed and committed.`, "info");
		state = { phase: "done", issueId: currentIssue.id };
		issue = undefined;
		persist();
	}

	async function runResumeReviewLoop(ctx: ExtensionContext): Promise<boolean> {
		while (issue) {
			pi.sendMessage(
				{
					customType: "bs-task-issue",
					content: `## ${formatIssueLabel(issue)}\n\n${buildIssueDisplay(issue)}`,
					display: true,
				},
				{ triggerTurn: false },
			);

			const choice = await ctx.ui.select(
				`Recovering issue #${issue.id} (phase: ${state.phase}) — what next?`,
				["Continue", "Add a comment", "Abort"],
			);

			if (!choice || choice === "Abort") {
				await locksRelease(pi, issue.id);
				ctx.ui.notify("Recovery aborted.", "info");
				return false;
			}

			if (choice.startsWith("Add")) {
				const body = await ctx.ui.editor("Comment:", "");
				if (body !== undefined && body.trim() !== "") {
					try {
						await issueComment(pi, issue.id, "human", body);
						issue = await issueShowJson(pi, issue.id);
					} catch (err) {
						ctx.ui.notify(`Failed to post comment: ${err}`, "error");
					}
				}
				continue;
			}

			return true;
		}
		return false;
	}

	async function routeRecoveredState(ctx: ExtensionContext): Promise<void> {
		if (!issue) return;
		const confirmed = await runResumeReviewLoop(ctx);
		if (!confirmed) return;
		const phase = state.phase;
		switch (phase) {
			case "done":
				ctx.ui.notify(`Issue #${issue.id} is already done.`, "info");
				return;
			case "implementing":
			case "implementing-red":
			case "implementing-green":
				await handleImplementationEnd(ctx, false);
				return;
			case "planning":
				await kickoffPhase(ctx, "planning", customTypeForPhase("planning"), buildPlanPrompt(issue), PLAN_TOOLS);
				return;
			case "planning-red":
				await kickoffPhase(ctx, "planning-red", customTypeForPhase("planning-red"), buildRedPlanPrompt(issue), PLAN_TOOLS);
				return;
			case "planning-green": {
				const diff = state.redDiff ?? "(unavailable — check `git log` for the red commit)";
				await kickoffPhase(ctx, "planning-green", customTypeForPhase("planning-green"), buildGreenPlanPrompt(issue, diff), PLAN_TOOLS);
				return;
			}
			default:
				ctx.ui.notify(`Recovered to phase '${phase}' — re-run /bs-task to continue.`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
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
				`/bs-task: postgres configuration not loaded — ${err instanceof Error ? err.message : String(err)}. Run 'npm run setup' to create .bogstandard/config.json.`,
				"error",
			);
			return;
		}
		state = loadState(ctx);
		if (state.issueId !== undefined && state.phase !== "idle" && state.phase !== "done") {
			try {
				issue = await issueShowJson(pi, state.issueId);
			} catch {
				ctx.ui.notify(
					`Could not refetch issue #${state.issueId}; resetting /bs-task state.`,
					"warning",
				);
				reset();
				return;
			}
		}
		const tools = activeToolsForPhase(state.phase);
		if (tools !== undefined) {
			pi.setActiveTools(tools);
		}
		// Honor freshly-passed --bs-*-model flags on resume. Without this,
		// `pi -r --bs-plan-model x` mid-planning would keep the session's
		// previous model until the next phase transition.
		await switchModelForPhase(ctx, state.phase);
	});
}

function hasBsEvents(iss: IssueDetail): boolean {
	return (iss.comments ?? []).some((c) => parseBsHeader(c.content.split("\n")[0]) !== null);
}

/**
 * Tool set associated with a phase, used on session resume to restore the
 * right active tools without re-running the kickoff side-effects.
 */
function activeToolsForPhase(phase: Phase): string[] | undefined {
	switch (phase) {
		case "planning":
		case "reviewing-plan":
		case "planning-red":
		case "reviewing-red-plan":
		case "planning-green":
		case "reviewing-green-plan":
			return PLAN_TOOLS;
		case "implementing":
		case "implementing-red":
			return IMPL_TOOLS;
		case "implementing-green":
			return GREEN_IMPL_TOOLS;
		default:
			return undefined;
	}
}
