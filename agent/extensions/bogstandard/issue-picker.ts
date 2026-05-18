/**
 * Issue picker: port of `pick_first_issue_id` from the shell orchestrator.
 *
 * Eligibility for picking:
 *   - status == "open"
 *   - no open subissues
 *   - no open blockers (every entry in `blocked_by` resolves to status != "open")
 *
 * Sort order:
 *   - by priority (critical < high < medium < low < other)
 *   - then by id ascending
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type IssueDetail, type IssueListEntry, issueList, issueShowJson } from "./chainlink.js";

const PRIORITY_RANK: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function priorityRank(priority: string | undefined): number {
	if (priority && priority in PRIORITY_RANK) {
		return PRIORITY_RANK[priority];
	}
	return 4;
}

function sortByPriorityThenId<T extends { id: number; priority?: string }>(issues: T[]): T[] {
	return [...issues].sort((a, b) => {
		const pa = priorityRank(a.priority);
		const pb = priorityRank(b.priority);
		if (pa !== pb) return pa - pb;
		return a.id - b.id;
	});
}

async function isEligible(pi: ExtensionAPI, issueId: number, signal?: AbortSignal): Promise<boolean> {
	const detail = await issueShowJson(pi, issueId, signal);

	if ((detail.subissues ?? []).some((sub) => sub.status === "open")) {
		return false;
	}

	for (const blockerId of detail.blocked_by ?? []) {
		const blocker = await issueShowJson(pi, blockerId, signal);
		if (blocker.status === "open") {
			return false;
		}
	}

	return true;
}

/**
 * Return all eligible open issues, sorted by priority then id.
 *
 * Note: this performs one `issue show --json` per open issue (to check
 * subissues + blockers), matching today's shell behavior. For repos with
 * many open issues this is O(N) chainlink calls.
 */
export async function listEligible(pi: ExtensionAPI, signal?: AbortSignal): Promise<IssueListEntry[]> {
	const all = await issueList(pi, signal);
	const open = all.filter((i) => i.status === "open");
	const sorted = sortByPriorityThenId(open);

	const eligible: IssueListEntry[] = [];
	for (const issue of sorted) {
		if (await isEligible(pi, issue.id, signal)) {
			eligible.push(issue);
		}
	}
	return eligible;
}

/**
 * Pick the first eligible issue, or `undefined` if none exists.
 * Short-circuits after the first match, so it's cheaper than `listEligible`
 * when callers only want the auto-pick.
 */
export async function pickFirstEligible(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<IssueListEntry | undefined> {
	const all = await issueList(pi, signal);
	const open = all.filter((i) => i.status === "open");
	const sorted = sortByPriorityThenId(open);

	for (const issue of sorted) {
		if (await isEligible(pi, issue.id, signal)) {
			return issue;
		}
	}
	return undefined;
}

/**
 * Format an issue for the autocomplete/picker UI.
 *   "#42 critical — Issue title"
 */
export function formatIssueLabel(issue: IssueListEntry | IssueDetail): string {
	const priority = issue.priority ? ` ${issue.priority}` : "";
	return `#${issue.id}${priority} — ${issue.title}`;
}
