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
 * Phase state for the /bs-task orchestrator.
 *
 * The source of truth lives in postgres: `issues.phase`, `issues.current_agent_id`,
 * and the `phase_events` audit log. `BogstandardState` is just the in-memory
 * cache the orchestrator keeps across event handlers — `loadState` rebuilds
 * it from the DB on session start, `transitionPhase` (in db.ts) is what
 * actually persists transitions.
 *
 * Transient working data — the in-flight plan, the red diff, a captured
 * bail reason — is reconstructed from the most recent phase_events row's
 * metadata, so a session restart picks up exactly where we left off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPool, recentPhaseEvents, type Phase, type PhaseEvent } from "./db.js";

export type { Phase } from "./db.js";

/**
 * In-memory snapshot of the orchestrator's current working state. Persistent
 * fields (`issueId`, `phase`, `versionId`) come from the issues row;
 * transient fields are populated from phase_events metadata on resume or
 * by the orchestrator's own tool handlers during a live session.
 */
export interface BogstandardState {
	/** undefined when the orchestrator is idle (no issue claimed). */
	issueId: number | undefined;
	phase: Phase | undefined;
	versionId: number | undefined;
	/** The current pending plan (set by `save_plan`, consumed by the next transition). */
	plan: string | undefined;
	/** Captured after the red commit; fed to the green planner & implementer. */
	redDiff: string | undefined;
	/** Set by the `bail_out` tool during green-impl. */
	bailReason: string | undefined;
	/** Set by the `propose_redraft` tool during any planning phase. */
	redraftDiagnosis: string | undefined;
	/** Short SHA of the red commit, captured so resume can roll back on bail recovery. */
	bailRedSha: string | undefined;
	/** Last prompt handed to the agent; replayed verbatim on Continue after an interrupt. */
	lastPrompt: string | undefined;
}

export const IDLE_STATE: BogstandardState = {
	issueId: undefined,
	phase: undefined,
	versionId: undefined,
	plan: undefined,
	redDiff: undefined,
	bailReason: undefined,
	redraftDiagnosis: undefined,
	bailRedSha: undefined,
	lastPrompt: undefined,
};

export function isActive(state: BogstandardState): boolean {
	return state.issueId !== undefined && state.phase !== undefined && state.phase !== "done" && state.phase !== "aborted";
}

export function isMidWorkPhase(phase: Phase | undefined): boolean {
	if (!phase) return false;
	return (
		phase === "planning" ||
		phase === "implementing" ||
		phase === "red_planning" ||
		phase === "red_impl" ||
		phase === "green_planning" ||
		phase === "green_impl"
	);
}

interface OwnedIssueRow {
	id: string;
	phase: Phase;
	current_version_id: string;
}

/**
 * Find the issue currently claimed by `agentId`. Returns null when none.
 * When multiple are claimed (shouldn't happen — one agent_id should never
 * hold more than one), the most recently active wins.
 */
async function findOwnedIssue(agentId: string): Promise<OwnedIssueRow | null> {
	const res = await getPool().query<OwnedIssueRow>(
		`SELECT id, phase, current_version_id
		   FROM issues
		  WHERE current_agent_id = $1
		    AND phase NOT IN ('done', 'aborted', 'archived')
		  ORDER BY phase_started_at DESC NULLS LAST, id DESC
		  LIMIT 1`,
		[agentId],
	);
	return res.rowCount === 0 ? null : res.rows[0];
}

/**
 * Rebuild the in-memory state for an issue from the DB. Pulls phase from
 * the issues row, then walks recent phase_events to recover transient
 * working data (plan, red SHA, bail SHA) the orchestrator needs to resume.
 */
export async function loadStateForIssue(pi: ExtensionAPI, issueId: number): Promise<BogstandardState> {
	const res = await getPool().query<{ phase: Phase; current_version_id: string }>(
		`SELECT phase, current_version_id FROM issues WHERE id = $1`,
		[issueId],
	);
	if (res.rowCount === 0) return { ...IDLE_STATE };

	const row = res.rows[0];
	const events = await recentPhaseEvents(pi, issueId, 20);
	return reconstructFromEvents(row.phase, issueId, Number(row.current_version_id), events);
}

/**
 * If our agent owns an active issue, build state for it. Otherwise idle.
 */
export async function loadState(pi: ExtensionAPI, agentId: string | null): Promise<BogstandardState> {
	if (!agentId) return { ...IDLE_STATE };
	const owned = await findOwnedIssue(agentId);
	if (!owned) return { ...IDLE_STATE };
	return loadStateForIssue(pi, Number(owned.id));
}

/**
 * Pure helper: reconstruct transient state by replaying recent events in
 * reverse-chronological order. Exposed for unit tests.
 */
export function reconstructFromEvents(
	phase: Phase,
	issueId: number,
	versionId: number,
	events: PhaseEvent[],
): BogstandardState {
	const state: BogstandardState = {
		...IDLE_STATE,
		issueId,
		phase,
		versionId,
	};

	// Walk newest → oldest. The first relevant event for each field wins.
	// Events from recentPhaseEvents are already ordered DESC by id.
	let foundPlan = false;
	let foundRedSha = false;
	let foundBailSha = false;

	for (const ev of events) {
		const md = ev.metadata ?? {};

		// Plan accompanies a transition INTO an implementing phase.
		if (!foundPlan && typeof md.plan === "string") {
			if (
				(phase === "implementing" && ev.phase_to === "implementing") ||
				(phase === "red_impl" && ev.phase_to === "red_impl") ||
				(phase === "green_impl" && ev.phase_to === "green_impl")
			) {
				state.plan = md.plan as string;
				foundPlan = true;
			}
		}

		// Red diff & sha: captured at transition into green_planning.
		if (!foundRedSha && typeof md.red_sha === "string") {
			if (typeof md.red_diff === "string") {
				state.redDiff = md.red_diff as string;
			}
			foundRedSha = true;
		}

		// Bail SHA: when we just transitioned back to red_planning via bail,
		// remember the red commit sha so resume can roll git back.
		if (!foundBailSha && phase === "red_planning" && typeof md.bail_sha === "string") {
			state.bailRedSha = md.bail_sha as string;
			foundBailSha = true;
		}
	}

	return state;
}

/**
 * Classify why an agent loop ended. Mirrors today's semantics but reads
 * from BogstandardState instead of pi.appendEntry, since state is now
 * DB-backed.
 *
 *   tool-terminate — save_plan, bail_out, or propose_redraft ran
 *   interrupted    — user Ctrl+C (stopReason "aborted") or transport/provider error ("error")
 *   completed      — natural finish or any other reason
 */
export function endReason(
	event: { messages: Array<{ role?: string; stopReason?: string }> },
	state: BogstandardState,
): "completed" | "tool-terminate" | "interrupted" {
	if (state.plan !== undefined && (state.phase === "planning" || state.phase === "red_planning" || state.phase === "green_planning")) {
		// save_plan was called: the plan is staged and the orchestrator will
		// open the plan-review UI on agent_end.
		return "tool-terminate";
	}
	if (state.phase === "green_impl" && state.bailReason !== undefined) {
		return "tool-terminate";
	}
	if (state.redraftDiagnosis !== undefined) {
		return "tool-terminate";
	}

	const lastMsg = event.messages.at(-1);
	if (lastMsg?.stopReason === "aborted" || lastMsg?.stopReason === "error") return "interrupted";
	return "completed";
}
