/**
 * Typed wrappers over `pi.exec("chainlink", ...)`.
 *
 * Replaces today's shell pipelines + jq in `bogstandard` and
 * `bogstandard-implement-issue`. All JSON output is parsed via JSON.parse;
 * non-zero exit codes are surfaced as thrown Errors so callers can catch
 * them at decision points (e.g. issue-fetch failure aborts the run).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommentKind =
	| "note"
	| "plan"
	| "decision"
	| "observation"
	| "blocker"
	| "resolution"
	| "result"
	| "handoff"
	| "human";

export interface IssueListEntry {
	id: number;
	title: string;
	status: string;
	priority?: string;
}

export interface IssueComment {
	kind: string;
	content: string;
}

export interface Subissue {
	id: number;
	status: string;
}

export interface IssueDetail {
	id: number;
	title: string;
	status: string;
	priority?: string;
	description?: string | null;
	comments?: IssueComment[];
	subissues?: Subissue[];
	blocked_by?: number[];
}

async function run(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await pi.exec("chainlink", args, { signal });
	if (result.code !== 0) {
		throw new Error(
			`chainlink ${args.join(" ")} exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
		);
	}
	return result.stdout;
}

export async function issueList(pi: ExtensionAPI, signal?: AbortSignal): Promise<IssueListEntry[]> {
	const stdout = await run(pi, ["issue", "list", "--json"], signal);
	const parsed = JSON.parse(stdout);
	if (!Array.isArray(parsed)) {
		throw new Error("chainlink issue list --json did not return an array");
	}
	return parsed as IssueListEntry[];
}

export async function issueShowJson(pi: ExtensionAPI, id: number, signal?: AbortSignal): Promise<IssueDetail> {
	const stdout = await run(pi, ["issue", "show", String(id), "--json"], signal);
	return JSON.parse(stdout) as IssueDetail;
}

export async function issueShowText(pi: ExtensionAPI, id: number, signal?: AbortSignal): Promise<string> {
	return run(pi, ["issue", "show", String(id)], signal);
}

export async function issueComment(
	pi: ExtensionAPI,
	id: number,
	kind: CommentKind,
	body: string,
	signal?: AbortSignal,
): Promise<void> {
	await run(pi, ["issue", "comment", "--kind", kind, String(id), body], signal);
}

export async function issueClose(pi: ExtensionAPI, id: number, signal?: AbortSignal): Promise<void> {
	await run(pi, ["issue", "close", String(id)], signal);
}

// ── Lock types (mirror LocksFile / Lock from chainlink/src/locks.rs) ─────────

export interface LockEntry {
	agent_id: string;
	branch: string | null;
	claimed_at: string; // ISO 8601
	signed_by: string;
}

export interface LocksFile {
	version: number;
	locks: Record<string, LockEntry>; // key = issue id as string
	settings: { stale_lock_timeout_minutes: number };
}

/** Returns null if locks aren't set up (no coordination branch / no network). */
export async function chainlinkLocksList(pi: ExtensionAPI): Promise<LocksFile | null> {
	try {
		const stdout = await run(pi, ["locks", "list", "--json"]);
		return JSON.parse(stdout) as LocksFile;
	} catch {
		return null;
	}
}

/** Read agent_id from .chainlink/agent.json. Returns null if not configured. */
export async function chainlinkAgentId(pi: ExtensionAPI): Promise<string | null> {
	try {
		const result = await pi.exec("cat", [".chainlink/agent.json"]);
		if (result.code !== 0) return null;
		const cfg = JSON.parse(result.stdout) as { agent_id?: string };
		return cfg.agent_id ?? null;
	} catch {
		return null;
	}
}

/**
 * A lock is stale if claimed_at is older than the timeout window. Since
 * BogStandard does not write heartbeats, age-since-claim is our proxy.
 */
export function isLockStale(entry: LockEntry, timeoutMinutes: number): boolean {
	const ageMs = Date.now() - new Date(entry.claimed_at).getTime();
	return ageMs > timeoutMinutes * 60 * 1000;
}

/** Claim a lock. Throws if locked by another agent. */
export async function chainlinkLocksClaim(
	pi: ExtensionAPI,
	issueId: number,
	branch?: string,
): Promise<void> {
	const args = ["locks", "claim", String(issueId)];
	if (branch) args.push("--branch", branch);
	await run(pi, args);
	// stdout: "Claimed lock" or "You already hold the lock" — both are fine.
}

/** Release a lock. Best-effort — does not throw if not locked. */
export async function chainlinkLocksRelease(pi: ExtensionAPI, issueId: number): Promise<void> {
	try {
		await run(pi, ["locks", "release", String(issueId)]);
	} catch {
		// Not our lock or already released — ignore.
	}
}

/** Steal (force-claim) a lock held by another agent. */
export async function chainlinkLocksSteal(pi: ExtensionAPI, issueId: number): Promise<void> {
	await run(pi, ["locks", "steal", String(issueId)]);
}

/** Mark the current session focus (best-effort human-facing signal). */
export async function chainlinkSessionWork(pi: ExtensionAPI, issueId: number): Promise<void> {
	try {
		await run(pi, ["session", "work", String(issueId)]);
	} catch {
		// Optional — never blocks the run.
	}
}

// ── Issue display ─────────────────────────────────────────────────────────────

/**
 * Rebuild the human-readable issue view that today's `build_display` shell
 * function emits: top-level description followed by each comment as a
 * heading section.
 */
export function buildIssueDisplay(issue: IssueDetail): string {
	const parts: string[] = [];
	if (issue.description && issue.description.trim() !== "") {
		parts.push(issue.description);
	}
	for (const comment of issue.comments ?? []) {
		parts.push(`# Comment (${comment.kind})\n\n${comment.content}`);
	}
	return parts.join("\n\n");
}
