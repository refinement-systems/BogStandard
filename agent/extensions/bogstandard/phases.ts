/**
 * Phase state for the bogstandard orchestrator.
 *
 * Persisted via `pi.appendEntry("bogstandard-phase", BogstandardPhaseEntry)`.
 * On `session_start` the extension walks back through entries to find the
 * latest entry of this customType and rehydrates `BogstandardState`.
 *
 * Two paths share this state: the no-tests path (planning → reviewing-plan
 * → implementing) and the TDD path (planning-red → reviewing-red-plan →
 * implementing-red → planning-green → reviewing-green-plan →
 * implementing-green, with optional bail back to planning-red).
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IssueComment, IssueDetail } from "./chainlink.js";

export type Phase =
	| "idle"
	// No-tests path
	| "planning"
	| "reviewing-plan"
	| "implementing"
	// TDD red phase
	| "planning-red"
	| "reviewing-red-plan"
	| "implementing-red"
	// TDD green phase
	| "planning-green"
	| "reviewing-green-plan"
	| "implementing-green"
	| "done";

export interface BogstandardState {
	phase: Phase;
	issueId?: number;
	/** The current pending plan (red, green, or no-tests, depending on phase). */
	plan?: string;
	/** Captured after the red commit; fed to the green planner & implementer. */
	redDiff?: string;
	/** Set by the bail_out tool during implementing-green. Triggers reset. */
	bailReason?: string;
	/** The prompt last sent to kickoffPhase; replayed when "Continue" is chosen after an interrupt. */
	lastPrompt?: string;
}

/**
 * Serialized blob written to `pi.appendEntry("bogstandard-phase", ...)`.
 * Keep this shape stable across versions; future versions can grow optional
 * fields but should not remove or repurpose existing ones.
 */
export interface BogstandardPhaseEntry {
	phase: Phase;
	issueId?: number;
	plan?: string;
	redDiff?: string;
	bailReason?: string;
	lastPrompt?: string;
}

const ENTRY_TYPE = "bogstandard-phase";

interface CustomEntry extends SessionEntry {
	type: "custom";
	customType?: string;
	data?: unknown;
}

function isOurEntry(entry: SessionEntry): entry is CustomEntry {
	const e = entry as CustomEntry;
	return e.type === "custom" && e.customType === ENTRY_TYPE;
}

/**
 * Walk the session entries (latest first) to find the most recent state.
 * Returns `{ phase: "idle" }` if no entry exists yet.
 */
export function loadState(ctx: ExtensionContext): BogstandardState {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isOurEntry(entry)) {
			const data = entry.data as BogstandardPhaseEntry | undefined;
			if (data && typeof data.phase === "string") {
				return {
					phase: data.phase,
					issueId: data.issueId,
					plan: data.plan,
					redDiff: data.redDiff,
					bailReason: data.bailReason,
					lastPrompt: data.lastPrompt,
				};
			}
		}
	}
	return { phase: "idle" };
}

export function saveState(pi: ExtensionAPI, state: BogstandardState): void {
	const entry: BogstandardPhaseEntry = {
		phase: state.phase,
		issueId: state.issueId,
		plan: state.plan,
		redDiff: state.redDiff,
		bailReason: state.bailReason,
		lastPrompt: state.lastPrompt,
	};
	pi.appendEntry(ENTRY_TYPE, entry);
}

/**
 * Build the machine-parseable HTML comment header for a durable BogStandard event.
 * Format: `<!-- bogstandard:v=1 event=<slug> [k=v ...] -->`
 */
export function buildBsHeader(event: string, attrs: Record<string, string> = {}): string {
	const pairs = [`event=${event}`, ...Object.entries(attrs).map(([k, v]) => `${k}=${v}`)].join(" ");
	return `<!-- bogstandard:v=1 ${pairs} -->`;
}

/**
 * Parse the first line of a chainlink comment body as a BogStandard header.
 * Returns a map of all key=value pairs (including `event`) or null if the line
 * is not a BogStandard header.
 */
export function parseBsHeader(line: string): Record<string, string> | null {
	const match = line.match(/^<!-- bogstandard:v=\d+ (.+?)-->$/);
	if (!match) return null;
	const attrs: Record<string, string> = {};
	for (const token of match[1].trim().split(/\s+/)) {
		const eq = token.indexOf("=");
		if (eq > 0) attrs[token.slice(0, eq)] = token.slice(eq + 1);
	}
	return attrs["event"] ? attrs : null;
}

interface BsEventRecord {
	event: string;
	attrs: Record<string, string>;
	body: string;
}

function extractBsEvents(comments: IssueComment[]): BsEventRecord[] {
	const events: BsEventRecord[] = [];
	for (const comment of comments) {
		const lines = comment.content.split("\n");
		const attrs = parseBsHeader(lines[0]);
		if (!attrs) continue;
		events.push({
			event: attrs["event"],
			attrs,
			body: lines.slice(1).join("\n").trim(),
		});
	}
	return events;
}

function findLast<T>(arr: T[], pred: (e: T) => boolean): T | undefined {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (pred(arr[i])) return arr[i];
	}
	return undefined;
}

/**
 * Reconstruct BogStandard phase state from chainlink comment history.
 *
 * Pure w.r.t. pi runtime — `gitShow` is injected so the function is
 * unit-testable without a real git process. Pass undefined to skip diff
 * reconstruction (tests that don't exercise the TDD path).
 *
 * Returns `{ phase: 'idle' }` when no BogStandard events are found.
 */
export async function reconstructState(
	issue: IssueDetail,
	gitShow?: (sha: string) => Promise<string>,
): Promise<BogstandardState> {
	const events = extractBsEvents(issue.comments ?? []);
	if (events.length === 0) return { phase: "idle" };

	const hasClosed = events.some(
		(e) => e.event === "closed" || e.event === "final-commit",
	);
	const hasGreenBail = events.some((e) => e.event === "green-bail");
	const lastGreenPlan = findLast(
		events,
		(e) => e.event === "plan-accepted" && e.attrs["phase"] === "planning-green",
	);
	const lastRedCommit = findLast(events, (e) => e.event === "red-commit");
	const lastRedPlan = findLast(
		events,
		(e) => e.event === "plan-accepted" && e.attrs["phase"] === "planning-red",
	);
	const lastNoPlan = findLast(
		events,
		(e) => e.event === "plan-accepted" && e.attrs["phase"] === "planning",
	);
	const pathChosen = findLast(events, (e) => e.event === "path-chosen");

	async function getRedDiff(sha: string | undefined): Promise<string | undefined> {
		if (!sha || !gitShow) return undefined;
		try {
			return await gitShow(sha);
		} catch {
			return "(unavailable — check `git log` for the red commit)";
		}
	}

	if (hasClosed) {
		return { phase: "done", issueId: issue.id };
	}
	if (hasGreenBail) {
		return { phase: "planning-red", issueId: issue.id };
	}
	if (lastGreenPlan) {
		const redDiff = await getRedDiff(lastRedCommit?.attrs["sha"]);
		return {
			phase: "implementing-green",
			issueId: issue.id,
			plan: lastGreenPlan.body || undefined,
			redDiff,
		};
	}
	if (lastRedCommit) {
		const redDiff = await getRedDiff(lastRedCommit.attrs["sha"]);
		return { phase: "planning-green", issueId: issue.id, redDiff };
	}
	if (lastRedPlan) {
		return {
			phase: "implementing-red",
			issueId: issue.id,
			plan: lastRedPlan.body || undefined,
		};
	}
	if (lastNoPlan) {
		return {
			phase: "implementing",
			issueId: issue.id,
			plan: lastNoPlan.body || undefined,
		};
	}
	if (pathChosen) {
		const phase = pathChosen.attrs["path"] === "tdd" ? "planning-red" : "planning";
		return { phase, issueId: issue.id };
	}
	return { phase: "idle" };
}

/**
 * Classify why an agent loop ended.
 *
 * "tool-terminate" — save_plan or bail_out ran (detectable from state side-effects).
 * "interrupted"    — user pressed Ctrl+C (stopReason "aborted" without tool side-effects).
 * "completed"      — natural finish (stopReason "stop") or any other reason.
 */
export function endReason(
	event: { messages: Array<{ role?: string; stopReason?: string }> },
	state: BogstandardState,
): "completed" | "tool-terminate" | "interrupted" {
	// save_plan transitions phase to reviewing-*; bail_out sets bailReason while staying in implementing-green
	if (state.phase.startsWith("reviewing-")) return "tool-terminate";
	if (state.phase === "implementing-green" && state.bailReason !== undefined) return "tool-terminate";

	const lastMsg = event.messages.at(-1);
	if (lastMsg?.stopReason === "aborted") return "interrupted";
	return "completed";
}
