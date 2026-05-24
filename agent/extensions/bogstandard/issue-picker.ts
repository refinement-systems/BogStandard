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
 *   - current version's needs_tests is set (NOT NULL) — Designer classified it
 *   - not currently claimed (current_agent_id IS NULL) or stale heartbeat
 *   - no subissues in a not-yet-resolved phase
 *   - no blockers in a not-yet-resolved phase
 *
 * "Not yet resolved" means phase NOT IN ('done', 'archived'). Aborted issues
 * still count as blocking because they were halted without resolution; they
 * need redraft + completion to release downstream work.
 *
 * Sort order: priority (critical → high → medium → low → other) then id.
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
	SELECT i.id, v.title, i.priority, i.phase, v.needs_tests
	  FROM issues i
	  JOIN issue_versions v ON v.id = i.current_version_id
	 WHERE i.phase = 'ready'
	   AND v.needs_tests IS NOT NULL
	   AND (i.current_agent_id IS NULL
	        OR i.phase_started_at < now() - ($1::int || ' minutes')::interval)
	   AND NOT EXISTS (
	         SELECT 1
	           FROM dependencies d
	           JOIN issues b ON d.blocker_id = b.id
	          WHERE d.blocked_id = i.id
	            AND b.phase NOT IN ('done', 'archived'))
	   AND NOT EXISTS (
	         SELECT 1
	           FROM issues s
	          WHERE s.parent_id = i.id
	            AND s.phase NOT IN ('done', 'archived'))
	 ORDER BY CASE i.priority
	            WHEN 'critical' THEN 0
	            WHEN 'high'     THEN 1
	            WHEN 'medium'   THEN 2
	            WHEN 'low'      THEN 3
	            ELSE 4
	          END, i.id
`;

interface EligibleRow extends Record<string, unknown> {
	id: string | number;
	title: string;
	priority: string;
	phase: Phase;
	needs_tests: boolean | null;
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

export async function pickFirstEligible(
	pi: ExtensionAPI,
	staleLockTimeoutMinutes: number,
): Promise<IssueListEntry | undefined> {
	const all = await listEligible(pi, staleLockTimeoutMinutes);
	return all[0];
}

/** "#42 critical — Issue title" */
export function formatIssueLabel(issue: IssueListEntry | IssueDetail): string {
	const priority = issue.priority ? ` ${issue.priority}` : "";
	return `#${issue.id}${priority} — ${issue.title}`;
}
