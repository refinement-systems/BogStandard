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
 * BogStandard — plan & implement issues end-to-end from pi.
 *
 * The orchestrator drives one issue at a time through a DB-backed phase
 * machine. needs_tests on the current issue version decides which path to
 * take:
 *
 *   needs_tests = false  →  planning → implementing → done
 *   needs_tests = true   →  red_planning → red_impl → green_planning
 *                           → green_impl → done
 *                          (with green-impl bail looping back to red_planning)
 *
 * State is persisted in postgres (issues.phase + phase_events). The
 * in-memory `state` here is just the orchestrator's working cache; it is
 * rebuilt from the DB on session_start by phases.loadState.
 *
 * The Designer stage (`/bs-design`) lives in ./designer.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildIssueDisplay,
	configureDb,
	getAgentId,
	getOwnership,
	getStaleTimeoutMinutes,
	claimIssue,
	releaseIssue,
	stealIssue,
	transitionPhase,
	appendPhaseEvent,
	recentPhaseEvents,
	isPhaseStale,
	issueArchive,
	issueComment,
	issueShowJson,
	type IssueDetail,
	type IssueListEntry,
	type Phase,
} from "./db.js";
import { loadConfig } from "./config.js";
import { addAll, commit, hasStagedChanges, headShortSha, isClean, resetHardHeadMinus1, resetHardToRef, showHeadDiff, statusShort } from "./git.js";
import { findBlockCycle, formatIssueLabel, listEligible, pickFirstEligible } from "./issue-picker.js";
import { IDLE_STATE, isMidWorkPhase, loadState, loadStateForIssue, endReason, type BogstandardState } from "./phases.js";
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

const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "questionnaire", "save_plan", "propose_redraft"];
const IMPL_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const GREEN_IMPL_TOOLS = [...IMPL_TOOLS, "bail_out"];

type PlanningPhase = "planning" | "red_planning" | "green_planning";
type ImplementingPhase = "implementing" | "red_impl" | "green_impl";

function isPlanningPhase(phase: Phase | undefined): phase is PlanningPhase {
	return phase === "planning" || phase === "red_planning" || phase === "green_planning";
}

function isImplementingPhase(phase: Phase | undefined): phase is ImplementingPhase {
	return phase === "implementing" || phase === "red_impl" || phase === "green_impl";
}

/** planning → implementing, red_planning → red_impl, green_planning → green_impl */
function implementingFor(planning: PlanningPhase): ImplementingPhase {
	switch (planning) {
		case "planning":       return "implementing";
		case "red_planning":   return "red_impl";
		case "green_planning": return "green_impl";
	}
}

export default function bogstandard(pi: ExtensionAPI) {
	let state: BogstandardState = { ...IDLE_STATE };
	let issue: IssueDetail | undefined;

	registerQuestionnaireTool(pi);

	registerDesigner(pi, {
		isTaskActive: () => state.issueId !== undefined && isMidWorkPhase(state.phase),
	});

	// ── Flags ─────────────────────────────────────────────────────────────────

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
			"Issue ID to work on (set by dispatch.sh to pre-assign workers). For interactive use, type '/bs-task <id>' in the prompt instead.",
		type: "string",
	});
	pi.registerFlag("bs-database-url", {
		description:
			"Postgres connection string (overrides BOGSTANDARD_DATABASE_URL and .bogstandard/config.json).",
		type: "string",
	});
	pi.registerFlag("bs-agent-id", {
		description:
			"Agent id used for issue ownership (overrides BOGSTANDARD_AGENT_ID and .bogstandard/config.json). Distinct ids let multiple workers hold distinct claims against the same database.",
		type: "string",
	});
	pi.registerFlag("bs-debug", {
		description: "Print the system prompt and user prompt before each agent phase starts.",
		type: "boolean",
	});

	// ── Tools ─────────────────────────────────────────────────────────────────

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
			return {
				content: [{ type: "text", text: "Plan saved. Stop now — do not call any more tools." }],
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

	pi.registerTool({
		name: "propose_redraft",
		label: "Propose Redraft",
		description:
			"Call this when you believe the issue itself is wrong, contradicts the codebase, or cannot be sensibly planned as written. Supply a precise diagnosis. The user will choose: continue planning, discuss with you, or bail back to the Designer for a redraft. Only available during planning phases.",
		parameters: Type.Object({
			diagnosis: Type.String({
				description: "What is wrong with the issue and why it cannot be planned as written",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)." }],
				};
			}
			const choice = await ctx.ui.select(
				`Planner disagrees with the design:\n\n${params.diagnosis}\n\nWhat next?`,
				[
					"Continue planning anyway",
					"Discuss with the planner",
					"Bail and redraft via Designer",
				],
			);
			if (!choice || choice.startsWith("Continue")) {
				return {
					content: [
						{
							type: "text",
							text: "The user has overruled your concern. Continue planning. Lock the relevant assumption in your plan's Resolved Questions section if it materially affects scope.",
						},
					],
				};
			}
			if (choice.startsWith("Discuss")) {
				const reply = await ctx.ui.editor("Your response to the planner:", "");
				const text = reply?.trim() ? reply.trim() : "(user provided no additional context)";
				return {
					content: [{ type: "text", text: `User response:\n\n${text}` }],
				};
			}
			// Bail
			state.redraftDiagnosis = params.diagnosis;
			return {
				content: [
					{
						type: "text",
						text: "The user agrees the issue needs redrafting. Stop now — do not call any more tools. Send a final message summarizing your diagnosis and end.",
					},
				],
				terminate: true,
			};
		},
	});

	// ── Phase system prompts ──────────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const phase = state.phase;
		if (phase === undefined) return undefined;
		if (
			phase === "planning" ||
			phase === "red_planning" ||
			phase === "green_planning" ||
			phase === "implementing" ||
			phase === "red_impl" ||
			phase === "green_impl"
		) {
			return { systemPrompt: buildPhaseSystemPrompt(phase, event.systemPrompt) };
		}
		return undefined;
	});

	// ── /bs-task command ──────────────────────────────────────────────────────

	pi.registerCommand("bs-task", {
		description: "Plan & implement the next eligible issue (or the one whose id you pass)",
		getArgumentCompletions: async (prefix) => {
			try {
				const stale = getStaleTimeoutMinutes();
				const eligible = await listEligible(pi, stale);
				const matching = eligible.filter((i) => String(i.id).startsWith(prefix));
				if (matching.length === 0) return null;
				return matching.map((i) => ({ value: String(i.id), label: formatIssueLabel(i) }));
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			// Mid-work resume: reconcile
			if (state.issueId !== undefined && isMidWorkPhase(state.phase)) {
				if (!issue) {
					try {
						issue = await issueShowJson(pi, state.issueId);
					} catch (err) {
						ctx.ui.notify(`Failed to fetch issue #${state.issueId}: ${err}`, "error");
						return;
					}
				}
				await reconcileResume(ctx);
				return;
			}

			// New pick
			let picked: IssueListEntry | undefined;
			const flagIssueId = pi.getFlag("bs-issue-id") as string | undefined;
			const arg = flagIssueId ?? args.trim();
			if (arg !== "") {
				const id = Number.parseInt(arg, 10);
				if (Number.isNaN(id)) {
					ctx.ui.notify(`Invalid issue id: ${arg}`, "error");
					return;
				}
				picked = { id, title: "", phase: "ready" };
			} else {
				try {
					picked = await pickFirstEligible(pi, getStaleTimeoutMinutes());
				} catch (err) {
					ctx.ui.notify(`Failed to query issues: ${err}`, "error");
					return;
				}
				if (!picked) {
					let cycleNote = "";
					try {
						const cycle = await findBlockCycle(pi);
						if (cycle && cycle.length > 0) {
							cycleNote = ` Block-graph cycle detected: ${cycle.map((id) => `#${id}`).join(" → ")}. Run /bs-design and use unblock to break it.`;
						}
					} catch {
						// non-fatal: best-effort diagnostic
					}
					ctx.ui.notify(
						`No eligible issues found.${cycleNote} Run /bs-design to draft or classify some.`,
						"warning",
					);
					return;
				}
			}

			try {
				issue = await issueShowJson(pi, picked.id);
			} catch (err) {
				ctx.ui.notify(`Failed to fetch issue #${picked.id}: ${err}`, "error");
				return;
			}

			// If the picked issue is mid-work, run reconciliation.
			if (isMidWorkPhase(issue.phase)) {
				state = await loadStateForIssue(pi, issue.id);
				await reconcileResume(ctx);
				return;
			}

			if (issue.phase !== "ready") {
				ctx.ui.notify(
					`Issue #${issue.id} is in phase '${issue.phase}' — only 'ready' issues can be started. Run /bs-design to redraft or unarchive.`,
					"error",
				);
				return;
			}

			if (issue.needs_tests === null || issue.needs_tests === undefined) {
				ctx.ui.notify(
					`Issue #${issue.id} is missing needs_tests classification. Run /bs-design to set it before /bs-task.`,
					"error",
				);
				return;
			}

			// Check + handle foreign ownership.
			const lockOk = await checkAndHandleOwnership(ctx, issue.id);
			if (lockOk === "abort") return;

			// Issue review.
			const confirmed = await runIssueReviewLoop(ctx);
			if (!confirmed || !issue) return;

			const myAgentId = await getAgentId(pi);
			if (!myAgentId) {
				ctx.ui.notify("/bs-task: no agent id configured. Cannot claim issue.", "error");
				return;
			}

			const claimed = await claimIssue(pi, issue.id, myAgentId, getStaleTimeoutMinutes());
			if (!claimed) {
				ctx.ui.notify(`Could not claim issue #${issue.id}: another agent holds the claim.`, "error");
				return;
			}

			const targetPhase: PlanningPhase = issue.needs_tests ? "red_planning" : "planning";

			if (targetPhase === "red_planning") {
				try {
					if (!(await isClean(pi))) {
						await releaseIssue(pi, issue.id, myAgentId);
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
			}

			try {
				await transitionPhase(pi, {
					issueId: issue.id,
					from: "ready",
					to: targetPhase,
					agentId: myAgentId,
					reason: targetPhase === "red_planning" ? "starting TDD path" : "starting direct-impl path",
				});
			} catch (err) {
				ctx.ui.notify(`Could not start phase '${targetPhase}': ${err}`, "error");
				await releaseIssue(pi, issue.id, myAgentId);
				return;
			}

			state = {
				...IDLE_STATE,
				issueId: issue.id,
				phase: targetPhase,
				versionId: issue.current_version_id,
			};

			await kickoffPhase(
				ctx,
				targetPhase,
				customTypeForPhase(targetPhase),
				targetPhase === "red_planning" ? buildRedPlanPrompt(issue) : buildPlanPrompt(issue),
				PLAN_TOOLS,
			);
		},
	});

	// ── Ownership: foreign-lock handling ──────────────────────────────────────

	async function checkAndHandleOwnership(ctx: ExtensionContext, issueId: number): Promise<"ok" | "abort"> {
		const myAgentId = await getAgentId(pi);
		if (!myAgentId) return "ok";
		const own = await getOwnership(pi, issueId);
		if (!own) return "ok";
		if (own.current_agent_id === null || own.current_agent_id === myAgentId) return "ok";
		const stale = isPhaseStale(own.phase_started_at, getStaleTimeoutMinutes());
		const ageMin = own.phase_started_at
			? Math.round((Date.now() - new Date(own.phase_started_at).getTime()) / 60000)
			: 0;
		const staleTag = stale ? " [STALE]" : "";
		ctx.ui.notify(
			`Issue #${issueId} is claimed by '${own.current_agent_id}' (${ageMin} min ago)${staleTag}`,
			"warning",
		);
		const choice = await ctx.ui.select("How would you like to proceed?", [
			"Pick a different issue",
			"Steal the claim",
			"Abort",
		]);
		if (!choice || choice === "Abort") {
			ctx.ui.notify("Aborted.", "info");
			return "abort";
		}
		if (choice.startsWith("Steal")) {
			try {
				await stealIssue(pi, issueId, myAgentId);
				ctx.ui.notify(`Stole claim on issue #${issueId}.`, "info");
				return "ok";
			} catch (err) {
				ctx.ui.notify(`Failed to steal claim: ${err}`, "error");
				return "abort";
			}
		}
		ctx.ui.notify("Re-run /bs-task to pick a different issue.", "info");
		return "abort";
	}

	// ── Issue review loop (pre-claim) ─────────────────────────────────────────

	async function runIssueReviewLoop(ctx: ExtensionContext): Promise<boolean> {
		while (issue) {
			const action = await showScrollableMarkdown<"continue" | "comment" | "show" | "archive" | "abort">(ctx, {
				title: `Issue #${issue.id} — ${formatIssueLabel(issue)}`,
				markdown: buildIssueDisplay(issue),
				actions: [
					{ keyId: "return", label: "↵ continue", result: "continue" },
					{ keyId: "c", label: "c comment", result: "comment" },
					{ keyId: "s", label: "s show others", result: "show" },
					{ keyId: "a", label: "a archive", result: "archive" },
					{ keyId: "escape", label: "esc abort", result: "abort" },
				],
			});

			if (action === "abort") {
				ctx.ui.notify("Aborted before planning.", "info");
				return false;
			}
			if (action === "archive") {
				try {
					await issueArchive(pi, issue.id, await getAgentId(pi));
					ctx.ui.notify(`Issue #${issue.id} archived.`, "info");
					return false;
				} catch (err) {
					ctx.ui.notify(`Failed to archive issue: ${err}`, "error");
				}
				continue;
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
					eligible = await listEligible(pi, getStaleTimeoutMinutes());
				} catch (err) {
					ctx.ui.notify(`Failed to query issues: ${err}`, "error");
					continue;
				}
				if (eligible.length === 0) {
					ctx.ui.notify("No other eligible issues.", "info");
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
			return true;
		}
		return false;
	}

	// ── Reconciliation on resume ──────────────────────────────────────────────

	async function reconcileResume(ctx: ExtensionContext): Promise<void> {
		if (!issue) return;
		const events = await recentPhaseEvents(pi, issue.id, 5);
		const lastEvent = events[0];
		const treeStatus = await safeGitStatus();
		const lines: string[] = [];
		lines.push(`**Phase:** ${state.phase}`);
		lines.push(`**Version:** v${issue.current_version_no}`);
		lines.push(`**needs_tests:** ${issue.needs_tests === null || issue.needs_tests === undefined ? "(unset)" : String(issue.needs_tests)}`);
		if (lastEvent) {
			lines.push(
				`**Last event:** ${lastEvent.phase_from ?? "(none)"} → ${lastEvent.phase_to}${lastEvent.reason ? ` — ${lastEvent.reason}` : ""}`,
			);
		}
		lines.push(`**Working tree:** ${treeStatus}`);
		lines.push("");
		lines.push("---");
		lines.push("");
		lines.push(buildIssueDisplay(issue));

		const action = await showScrollableMarkdown<"continue" | "abandon" | "redraft">(ctx, {
			title: `Resume issue #${issue.id} — ${issue.title}`,
			markdown: lines.join("\n"),
			actions: [
				{ keyId: "return", label: "↵ continue", result: "continue" },
				{ keyId: "a", label: "a abandon", result: "abandon" },
				{ keyId: "escape", label: "esc explain to Designer", result: "redraft" },
			],
		});

		if (action === "continue") {
			await routeContinueResume(ctx);
			return;
		}

		const myAgentId = await getAgentId(pi);
		if (action === "abandon") {
			await abortIssue(ctx, "user abandoned during resume", myAgentId);
			return;
		}
		// redraft path: ask for an explanation
		const reason = await ctx.ui.editor(
			"Explain what's wrong so the Designer can redraft. Leave blank to abandon without a reason:",
			"",
		);
		const reasonText = reason && reason.trim() ? reason.trim() : "(no reason provided)";
		await abortIssue(ctx, reasonText, myAgentId);
		ctx.ui.notify(
			`Issue #${issue.id} marked 'aborted'. Run /bs-design to redraft it.`,
			"info",
		);
	}

	async function safeGitStatus(): Promise<string> {
		try {
			const clean = await isClean(pi);
			if (clean) return "clean";
			const summary = (await statusShort(pi)).trim().split("\n").filter((l) => l).length;
			return `dirty (${summary} file${summary === 1 ? "" : "s"})`;
		} catch {
			return "(could not read git status)";
		}
	}

	async function abortIssue(ctx: ExtensionContext, reason: string, agentId: string | null): Promise<void> {
		if (!issue || !state.phase) return;
		try {
			await transitionPhase(pi, {
				issueId: issue.id,
				from: state.phase,
				to: "aborted",
				agentId,
				reason,
			});
		} catch (err) {
			ctx.ui.notify(`Could not transition to aborted: ${err}`, "error");
			return;
		}
		if (agentId) await releaseIssue(pi, issue.id, agentId);
		ctx.ui.notify(`Issue #${issue.id} aborted.`, "info");
		state = { ...IDLE_STATE };
		issue = undefined;
	}

	async function routeContinueResume(ctx: ExtensionContext): Promise<void> {
		if (!issue || !state.phase) return;
		const phase = state.phase;
		switch (phase) {
			case "planning":
				await kickoffPhase(ctx, "planning", customTypeForPhase("planning"), buildPlanPrompt(issue), PLAN_TOOLS);
				return;
			case "implementing":
				await handleImplementationEnd(ctx, false);
				return;
			case "red_planning": {
				if (state.bailRedSha) {
					ctx.ui.notify(
						`Resetting git to before the red commit (${state.bailRedSha}) to clean up the aborted TDD cycle.`,
						"info",
					);
					try {
						await resetHardToRef(pi, `${state.bailRedSha}~1`);
					} catch (err) {
						ctx.ui.notify(
							`Could not auto-reset to ${state.bailRedSha}~1: ${err}. Reset manually before continuing.`,
							"warning",
						);
					}
					state.bailRedSha = undefined;
				}
				await kickoffPhase(ctx, "red_planning", customTypeForPhase("red_planning"), buildRedPlanPrompt(issue), PLAN_TOOLS);
				return;
			}
			case "red_impl":
				await handleImplementationEnd(ctx, false);
				return;
			case "green_planning": {
				const diff = state.redDiff ?? "(unavailable — check `git log` for the red commit)";
				await kickoffPhase(
					ctx,
					"green_planning",
					customTypeForPhase("green_planning"),
					buildGreenPlanPrompt(issue, diff),
					PLAN_TOOLS,
				);
				return;
			}
			case "green_impl":
				await handleImplementationEnd(ctx, false);
				return;
			default:
				ctx.ui.notify(`Recovered to phase '${phase}' — nothing to do.`, "warning");
		}
	}

	// ── agent_end dispatcher ──────────────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!issue || state.issueId === undefined) return;
		try {
			const reason = endReason(event, state);

			if (state.redraftDiagnosis !== undefined) {
				await handleProposeRedraft(ctx);
				return;
			}

			if (reason === "interrupted") {
				await handleInterrupt(ctx);
				return;
			}

			if (isPlanningPhase(state.phase) && state.plan) {
				await handlePlanReview(ctx);
				return;
			}

			if (isImplementingPhase(state.phase)) {
				if (state.phase === "green_impl" && state.bailReason !== undefined) {
					await handleBail(ctx);
				} else {
					await handleImplementationEnd(ctx, false);
				}
				return;
			}
		} catch (err) {
			ctx.ui.notify(`/bs-task: ${err}`, "error");
		}
	});

	// ── propose_redraft handler ───────────────────────────────────────────────

	async function handleProposeRedraft(ctx: ExtensionContext): Promise<void> {
		if (!issue || !state.phase || !state.redraftDiagnosis) return;
		const myAgentId = await getAgentId(pi);
		const reason = `propose_redraft: ${state.redraftDiagnosis}`;
		try {
			await transitionPhase(pi, {
				issueId: issue.id,
				from: state.phase,
				to: "aborted",
				agentId: myAgentId,
				reason,
			});
		} catch (err) {
			ctx.ui.notify(`Could not transition to aborted: ${err}`, "error");
			return;
		}
		if (myAgentId) await releaseIssue(pi, issue.id, myAgentId);
		ctx.ui.notify(
			`Issue #${issue.id} aborted (planner asked for redraft). Run /bs-design to revise the issue.`,
			"info",
		);
		state = { ...IDLE_STATE };
		issue = undefined;
	}

	// ── Plan review ────────────────────────────────────────────────────────────

	async function handlePlanReview(ctx: ExtensionContext): Promise<void> {
		if (!issue || !state.phase || !state.plan || !isPlanningPhase(state.phase)) return;
		const planningPhase: PlanningPhase = state.phase;

		const action = await showScrollableMarkdown<"accept" | "escape">(ctx, {
			title: `Plan for issue #${issue.id}`,
			markdown: state.plan,
			actions: [
				{ keyId: "return", label: "↵ accept", result: "accept" },
				{ keyId: "escape", label: "esc refine / abort", result: "escape" },
			],
		});

		if (action === "accept") {
			await acceptPlan(ctx, planningPhase, state.plan);
			return;
		}

		const choice = await ctx.ui.select("Plan not accepted — what next?", [
			"Send instructions to the planner",
			"Abort",
		]);
		if (!choice || choice === "Abort") {
			const myAgentId = await getAgentId(pi);
			await abortIssue(ctx, "user aborted after planning", myAgentId);
			return;
		}
		const refinement = await ctx.ui.editor("Instructions for the planner:", "");
		if (refinement === undefined || refinement.trim() === "") {
			ctx.ui.notify("No refinement entered; plan review left pending.", "info");
			return;
		}
		const myAgentId = await getAgentId(pi);
		try {
			await appendPhaseEvent(pi, {
				issueId: issue.id,
				phase: planningPhase,
				agentId: myAgentId,
				reason: "plan-refine-instructions",
				metadata: { instructions: refinement.trim() },
			});
		} catch {
			// non-fatal
		}
		state.plan = undefined;
		setTimeout(() => pi.sendUserMessage(refinement.trim()), 0);
	}

	async function acceptPlan(ctx: ExtensionContext, from: PlanningPhase, plan: string): Promise<void> {
		if (!issue) return;
		const to = implementingFor(from);
		const myAgentId = await getAgentId(pi);
		try {
			await transitionPhase(pi, {
				issueId: issue.id,
				from,
				to,
				agentId: myAgentId,
				reason: "plan accepted",
				metadata: { plan },
			});
		} catch (err) {
			ctx.ui.notify(`Could not transition to ${to}: ${err}`, "error");
			return;
		}
		state.phase = to;
		state.plan = plan;

		let prompt: string;
		let tools: string[];
		if (to === "implementing") {
			prompt = buildImplementPrompt(issue, plan);
			tools = IMPL_TOOLS;
		} else if (to === "red_impl") {
			prompt = buildRedImplementPrompt(issue, plan);
			tools = IMPL_TOOLS;
		} else {
			const diff = state.redDiff ?? "(unavailable — check `git log` for the red commit)";
			prompt = buildGreenImplementPrompt(issue, plan, diff);
			tools = GREEN_IMPL_TOOLS;
		}
		await kickoffPhase(ctx, to, customTypeForPhase(to), prompt, tools);
	}

	// ── Implementation end ────────────────────────────────────────────────────

	async function handleImplementationEnd(ctx: ExtensionContext, isInterrupted: boolean): Promise<void> {
		if (!issue || !state.phase || !isImplementingPhase(state.phase)) return;
		const phase: ImplementingPhase = state.phase;

		const doneLabel =
			phase === "red_impl" ? "Done (proceed to green phase)" : "Done (close and commit)";

		const choice = await ctx.ui.select(
			isInterrupted ? "Phase interrupted — what next?" : "Implementation complete — what next?",
			[
				doneLabel,
				"Not done (continue working)",
				"Not done, quitting (commit incomplete work, leave issue open)",
			],
		);

		if (!choice || choice.startsWith("Done")) {
			if (phase === "implementing") {
				await closeAndCommit(ctx, issue);
			} else if (phase === "red_impl") {
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
				const myAgentId = await getAgentId(pi);
				if (myAgentId) await releaseIssue(pi, issue.id, myAgentId);
				ctx.ui.notify("Aborted in-session. Issue left in-progress; re-run /bs-task to resume.", "info");
				state = { ...IDLE_STATE };
				issue = undefined;
				return;
			}
			let prompt = userInput.trim() || defaultPrompt;
			if (!prompt) {
				if (phase === "implementing" && state.plan) {
					prompt = buildImplementPrompt(issue, state.plan);
				} else if (phase === "red_impl" && state.plan) {
					prompt = buildRedImplementPrompt(issue, state.plan);
				} else if (phase === "green_impl" && state.plan && state.redDiff) {
					prompt = buildGreenImplementPrompt(issue, state.plan, state.redDiff);
				} else {
					prompt = "Continue working on the implementation.";
				}
			}
			const tools = activeToolsForPhase(phase)!;
			await kickoffPhase(ctx, phase, customTypeForPhase(phase), prompt, tools);
			return;
		}

		// Not done, quitting
		const comment = await ctx.ui.editor("Comment for the issue (leave blank to skip):", "");
		if (comment !== undefined && comment.trim()) {
			try {
				await issueComment(pi, issue.id, "human", comment.trim());
			} catch (err) {
				ctx.ui.notify(`Failed to post comment: ${err}`, "warning");
			}
		}
		try {
			await addAll(pi);
			await commit(pi, `[WIP] ${issue.title}`, "Work in progress — session ended without completing issue.");
		} catch (err) {
			ctx.ui.notify(`Failed to commit incomplete work: ${err}`, "warning");
		}
		const myAgentId = await getAgentId(pi);
		try {
			await appendPhaseEvent(pi, {
				issueId: issue.id,
				phase,
				agentId: myAgentId,
				reason: "user quit mid-phase, WIP committed",
			});
		} catch {
			// non-fatal
		}
		if (myAgentId) await releaseIssue(pi, issue.id, myAgentId);
		ctx.ui.notify(
			`Issue #${issue.id} left in phase '${phase}'. Re-run /bs-task ${issue.id} to resume.`,
			"info",
		);
		state = { ...IDLE_STATE };
		issue = undefined;
	}

	// ── Interrupt ─────────────────────────────────────────────────────────────

	async function handleInterrupt(ctx: ExtensionContext): Promise<void> {
		const phase = state.phase;
		if (phase === undefined) return;

		if (isImplementingPhase(phase)) {
			await handleImplementationEnd(ctx, true);
			return;
		}
		if (isPlanningPhase(phase)) {
			const choice = await ctx.ui.select("Phase interrupted — what next?", [
				"Continue (resume planner)",
				"Abort",
			]);
			if (!choice || choice === "Abort") {
				const myAgentId = await getAgentId(pi);
				await abortIssue(ctx, "user aborted after interrupt", myAgentId);
				return;
			}
			const correction = await ctx.ui.editor("Correction for the planner (leave blank to resume):", "");
			if (correction === undefined) {
				const myAgentId = await getAgentId(pi);
				await abortIssue(ctx, "user cancelled correction editor", myAgentId);
				return;
			}
			if (correction.trim()) {
				setTimeout(() => pi.sendUserMessage(correction.trim()), 0);
				return;
			}
			if (!state.lastPrompt) {
				ctx.ui.notify("No saved prompt to resume from. Re-run /bs-task.", "error");
				return;
			}
			const tools = activeToolsForPhase(phase)!;
			await kickoffPhase(ctx, phase, customTypeForPhase(phase), state.lastPrompt, tools);
			return;
		}

		const myAgentId = await getAgentId(pi);
		await abortIssue(ctx, `unexpected interrupt during '${phase}'`, myAgentId);
	}

	// ── Red phase finalization ────────────────────────────────────────────────

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
				"Red phase produced no changes. The implementer was supposed to write failing tests. Use /bs-task to retry.",
				"error",
			);
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
			// non-fatal
		}
		let diff: string;
		try {
			diff = await showHeadDiff(pi);
		} catch (err) {
			ctx.ui.notify(`Failed to capture red diff: ${err}`, "error");
			return;
		}

		const myAgentId = await getAgentId(pi);
		try {
			await transitionPhase(pi, {
				issueId: issue.id,
				from: "red_impl",
				to: "green_planning",
				agentId: myAgentId,
				reason: "red phase committed",
				metadata: { red_sha: sha, red_diff: diff },
			});
		} catch (err) {
			ctx.ui.notify(`Could not transition to green_planning: ${err}`, "error");
			return;
		}

		state.plan = undefined;
		state.redDiff = diff;
		state.phase = "green_planning";
		await kickoffPhase(
			ctx,
			"green_planning",
			customTypeForPhase("green_planning"),
			buildGreenPlanPrompt(issue, diff),
			PLAN_TOOLS,
		);
	}

	// ── Green bail ────────────────────────────────────────────────────────────

	async function handleBail(ctx: ExtensionContext): Promise<void> {
		if (!issue || state.bailReason === undefined) return;
		const reason = state.bailReason;

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

		// Capture the red sha (HEAD before reset) so resume can roll back if interrupted.
		let bailSha = "unknown";
		try {
			bailSha = await headShortSha(pi);
		} catch {
			// non-fatal
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

		const myAgentId = await getAgentId(pi);
		try {
			await transitionPhase(pi, {
				issueId: issue.id,
				from: "green_impl",
				to: "red_planning",
				agentId: myAgentId,
				reason: `green bail: ${reason}`,
				metadata: { bail_sha: bailSha, bail_reason: reason },
			});
		} catch (err) {
			ctx.ui.notify(`Could not transition to red_planning after bail: ${err}`, "error");
			return;
		}

		state.plan = undefined;
		state.redDiff = undefined;
		state.bailReason = undefined;
		state.phase = "red_planning";

		try {
			issue = await issueShowJson(pi, issue.id);
		} catch (err) {
			ctx.ui.notify(`Failed to refetch issue after bail: ${err}`, "error");
			return;
		}

		ctx.ui.notify("Bail handled. Restarting red phase with updated context.", "info");
		await kickoffPhase(
			ctx,
			"red_planning",
			customTypeForPhase("red_planning"),
			buildRedPlanPrompt(issue),
			PLAN_TOOLS,
		);
	}

	// ── Close + commit ────────────────────────────────────────────────────────

	async function closeAndCommit(ctx: ExtensionContext, currentIssue: IssueDetail): Promise<void> {
		let clean = false;
		try {
			clean = await isClean(pi);
		} catch {
			// proceed normally
		}

		const myAgentId = await getAgentId(pi);

		if (clean) {
			while (true) {
				const choice = await ctx.ui.select(
					"No file changes detected — what would you like to do?",
					[
						"Close issue without committing",
						"Add a comment",
						"Abort (leave issue open)",
					],
				);
				if (!choice || choice.startsWith("Abort")) {
					if (myAgentId) await releaseIssue(pi, currentIssue.id, myAgentId);
					ctx.ui.notify("Aborted. Issue left in-progress.", "info");
					return;
				}
				if (choice.startsWith("Add a comment")) {
					const body = await ctx.ui.editor("Comment:", "");
					if (body !== undefined && body.trim() !== "") {
						try {
							await issueComment(pi, currentIssue.id, "human", body);
						} catch (err) {
							ctx.ui.notify(`Failed to post comment: ${err}`, "error");
						}
					}
					continue;
				}
				break; // close without commit
			}
			try {
				await transitionPhase(pi, {
					issueId: currentIssue.id,
					from: state.phase,
					to: "done",
					agentId: myAgentId,
					reason: "closed without file changes",
				});
			} catch (err) {
				ctx.ui.notify(`Failed to close issue: ${err}`, "error");
				return;
			}
			if (myAgentId) await releaseIssue(pi, currentIssue.id, myAgentId);
			ctx.ui.notify(`Issue #${currentIssue.id} closed (no files changed).`, "info");
			state = { ...IDLE_STATE };
			issue = undefined;
			return;
		}

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

		try {
			await transitionPhase(pi, {
				issueId: currentIssue.id,
				from: state.phase,
				to: "done",
				agentId: myAgentId,
				reason: "implementation committed",
				metadata: { final_sha: sha },
			});
		} catch (err) {
			ctx.ui.notify(`Failed to close issue: ${err}`, "error");
			return;
		}
		if (myAgentId) await releaseIssue(pi, currentIssue.id, myAgentId);

		ctx.ui.notify(`Issue #${currentIssue.id} closed and committed (${sha}).`, "info");
		state = { ...IDLE_STATE };
		issue = undefined;
	}

	// ── Kickoff + model selection ─────────────────────────────────────────────

	function resolveModelFor(phase: Phase): string | undefined {
		const broadPlan = pi.getFlag("bs-plan-model") as string | undefined;
		const broadImpl = pi.getFlag("bs-impl-model") as string | undefined;
		const get = (name: string) => pi.getFlag(name) as string | undefined;
		switch (phase) {
			case "planning":        return broadPlan;
			case "implementing":    return broadImpl;
			case "red_planning":    return get("bs-red-plan-model")   ?? broadPlan;
			case "red_impl":        return get("bs-red-impl-model")   ?? broadImpl;
			case "green_planning":  return get("bs-green-plan-model") ?? broadPlan;
			case "green_impl":      return get("bs-green-impl-model") ?? broadImpl;
			default:                return undefined;
		}
	}

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
		if (!ok) ctx.ui.notify(`/bs-task: no API key configured for ${spec}`, "error");
	}

	function buildPhaseSystemPrompt(phase: Phase, base: string): string {
		switch (phase) {
			case "planning":
			case "red_planning":
			case "green_planning":
				return buildPlannerSystemPrompt();
			case "implementing":
			case "red_impl":
				return buildImplementerSystemPrompt();
			case "green_impl":
				return buildGreenImplementerSystemPrompt();
			default:
				return base;
		}
	}

	function customTypeForPhase(phase: Phase): string {
		switch (phase) {
			case "planning":        return "bs-task-plan-prompt";
			case "red_planning":    return "bs-task-red-plan-prompt";
			case "green_planning":  return "bs-task-green-plan-prompt";
			case "implementing":    return "bs-task-impl-prompt";
			case "red_impl":        return "bs-task-red-impl-prompt";
			case "green_impl":      return "bs-task-green-impl-prompt";
			default:                return "bs-task-prompt";
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
		setTimeout(() => {
			pi.sendMessage({ customType, content, display: false }, { triggerTurn: true });
		}, 0);
	}

	function activeToolsForPhase(phase: Phase): string[] | undefined {
		switch (phase) {
			case "planning":
			case "red_planning":
			case "green_planning":
				return PLAN_TOOLS;
			case "implementing":
			case "red_impl":
				return IMPL_TOOLS;
			case "green_impl":
				return GREEN_IMPL_TOOLS;
			default:
				return undefined;
		}
	}

	// ── session_start: configure DB, restore state ────────────────────────────

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
				`/bs-task: postgres configuration not loaded — ${err instanceof Error ? err.message : String(err)}. Run 'bs-setup' to create .bogstandard/config.json.`,
				"error",
			);
			return;
		}

		const agentId = await getAgentId(pi);
		state = await loadState(pi, agentId);
		if (state.issueId !== undefined) {
			try {
				issue = await issueShowJson(pi, state.issueId);
			} catch {
				ctx.ui.notify(`Could not refetch issue #${state.issueId}; clearing state.`, "warning");
				state = { ...IDLE_STATE };
				issue = undefined;
				return;
			}
		}

		const tools = state.phase ? activeToolsForPhase(state.phase) : undefined;
		if (tools !== undefined) pi.setActiveTools(tools);

		if (state.phase) await switchModelForPhase(ctx, state.phase);
	});
}
