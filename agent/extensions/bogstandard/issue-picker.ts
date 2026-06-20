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
 * Issue picker.
 *
 * Eligibility:
 *   - phase = 'ready'
 *   - current version's workflow_id is set (NOT NULL) — Designer classified it
 *   - not currently claimed (current_agent_id IS NULL) or stale heartbeat
 *   - no blockers in a not-yet-resolved phase
 *
 * "Not yet resolved" means phase NOT IN ('done', 'archived'). Aborted issues
 * still count as blocking because they were halted without resolution; they
 * need redraft + completion to release downstream work.
 *
 * Sort order: priority (critical → high → medium → low → other) then id.
 *
 * `findBlockCycle` is the second-line diagnostic: when the picker returns
 * nothing the caller invokes it to distinguish "no work scheduled" from
 * "the block graph has a cycle and is deadlocked". `dependencyAdd` rejects
 * cycles at insertion time, but the importer and manual SQL can still
 * introduce them, so the picker keeps a runtime check.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPool, type IssueDetail, type IssueListEntry, type Phase } from "./db.js";

export interface QueryRunner {
	query<R extends Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<{ rows: R[] }>;
}

export const ELIGIBLE_SQL = `
	SELECT i.id, v.title, i.priority, i.phase, v.needs_tests, v.workflow_id
	  FROM issues i
	  JOIN issue_versions v ON v.id = i.current_version_id
	 WHERE i.phase = 'ready'
	   AND v.workflow_id IS NOT NULL
	   AND (i.current_agent_id IS NULL
	        OR i.phase_started_at < now() - ($1::int || ' minutes')::interval)
	   AND NOT EXISTS (
	         SELECT 1
	           FROM dependencies d
	           JOIN issues b ON d.blocker_id = b.id
	          WHERE d.blocked_id = i.id
	            AND b.phase NOT IN ('done', 'archived'))
	 ORDER BY CASE i.priority
	            WHEN 'critical' THEN 0
	            WHEN 'high'     THEN 1
	            WHEN 'medium'   THEN 2
	            WHEN 'low'      THEN 3
	            ELSE 4
	          END, i.id
`;

/**
 * Recursive walk over `dependencies`: for every issue, follow blocker→blocked
 * edges until we re-enter the start node (cycle) or exhaust the frontier.
 * `array_length(path, 1) < 200` is a safety bound — real graphs are tiny.
 */
export const FIND_CYCLE_SQL = `
	WITH RECURSIVE walk(start_id, current_id, path, found) AS (
	  SELECT id, id, ARRAY[id]::bigint[], false FROM issues
	  UNION ALL
	  SELECT w.start_id,
	         d.blocked_id,
	         w.path || d.blocked_id,
	         d.blocked_id = w.start_id
	    FROM walk w
	    JOIN dependencies d ON d.blocker_id = w.current_id
	   WHERE NOT w.found
	     AND array_length(w.path, 1) < 200
	     AND NOT (d.blocked_id = ANY(w.path) AND d.blocked_id <> w.start_id)
	)
	SELECT path FROM walk WHERE found LIMIT 1
`;

export const PENDING_MERGES_SQL = `
	SELECT i.id, i.phase
	  FROM issues i
	 WHERE i.phase IN ('merging_pending', 'merging', 'merge_repair', 'merge_failed')
	 ORDER BY i.id
`;

interface EligibleRow extends Record<string, unknown> {
	id: string | number;
	title: string;
	priority: string;
	phase: Phase;
	needs_tests: boolean | null;
	workflow_id: string | null;
}

export interface PendingMergeEntry {
	id: number;
	phase: Extract<Phase, "merging_pending" | "merging" | "merge_repair" | "merge_failed">;
}

interface PendingMergeRow extends Record<string, unknown> {
	id: string | number;
	phase: PendingMergeEntry["phase"];
}

export async function listEligibleWith(
	runner: QueryRunner,
	staleLockTimeoutMinutes: number,
): Promise<IssueListEntry[]> {
	const result = await runner.query<EligibleRow>(ELIGIBLE_SQL, [staleLockTimeoutMinutes]);
	return result.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		phase: r.phase,
		status: r.phase,
		priority: r.priority,
	}));
}

export async function listEligible(_pi: ExtensionAPI, staleLockTimeoutMinutes: number): Promise<IssueListEntry[]> {
	return listEligibleWith(getPool(), staleLockTimeoutMinutes);
}

export async function listPendingMergesWith(runner: QueryRunner): Promise<PendingMergeEntry[]> {
	const result = await runner.query<PendingMergeRow>(PENDING_MERGES_SQL);
	return result.rows.map((r) => ({
		id: Number(r.id),
		phase: r.phase,
	}));
}

export async function listPendingMerges(_pi: ExtensionAPI): Promise<PendingMergeEntry[]> {
	return listPendingMergesWith(getPool());
}

export async function pickFirstEligible(
	pi: ExtensionAPI,
	staleLockTimeoutMinutes: number,
): Promise<IssueListEntry | undefined> {
	const all = await listEligible(pi, staleLockTimeoutMinutes);
	return all[0];
}

/**
 * Walks the block graph looking for any cycle. Returns the ids that form a
 * sample cycle (start node repeated at the end), or null when the graph is
 * acyclic. Cheap on small graphs; bounded to depth 200 by the CTE.
 */
export async function findBlockCycleWith(runner: QueryRunner): Promise<number[] | null> {
	const res = await runner.query<{ path: Array<string | number> | null }>(FIND_CYCLE_SQL);
	const path = res.rows[0]?.path;
	if (!path || path.length === 0) return null;
	return path.map((v) => Number(v));
}

export async function findBlockCycle(_pi: ExtensionAPI): Promise<number[] | null> {
	return findBlockCycleWith(getPool());
}

/** "#42 critical — Issue title" */
export function formatIssueLabel(issue: IssueListEntry | IssueDetail): string {
	const priority = issue.priority ? ` ${issue.priority}` : "";
	return `#${issue.id}${priority} — ${issue.title}`;
}
