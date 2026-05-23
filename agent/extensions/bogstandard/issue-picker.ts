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
 * Issue picker, postgres-backed.
 *
 * Eligibility:
 *   - status = 'open'
 *   - no open subissues
 *   - no open blockers
 *
 * Sort order: priority (critical → high → medium → low → other) then id.
 * Everything is done in a single SQL query rather than the N+1 loop the
 * shell version used.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPool, type IssueDetail, type IssueListEntry } from "./db.js";

/**
 * Minimal query interface used by `listEligibleWith`. Anything with a
 * compatible `.query(text, params)` signature works — including `pg.Pool`
 * and the stub used in unit tests.
 */
export interface QueryRunner {
	query<R extends Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<{ rows: R[] }>;
}

export const ELIGIBLE_SQL = `
	SELECT i.id, i.title, i.priority, i.status
	  FROM issues i
	 WHERE i.status = 'open'
	   AND NOT EXISTS (
	         SELECT 1
	           FROM dependencies d
	           JOIN issues b ON d.blocker_id = b.id
	          WHERE d.blocked_id = i.id AND b.status = 'open')
	   AND NOT EXISTS (
	         SELECT 1
	           FROM issues s
	          WHERE s.parent_id = i.id AND s.status = 'open')
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
	status: string;
}

/**
 * Pure-ish: run the eligibility query against a caller-supplied runner.
 * Exposed for unit tests that pass in a stub query function.
 */
export async function listEligibleWith(runner: QueryRunner): Promise<IssueListEntry[]> {
	const result = await runner.query<EligibleRow>(ELIGIBLE_SQL);
	return result.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		status: r.status,
		priority: r.priority,
	}));
}

export async function listEligible(
	_pi: ExtensionAPI,
	_signal?: AbortSignal,
): Promise<IssueListEntry[]> {
	return listEligibleWith(getPool());
}

export async function pickFirstEligible(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<IssueListEntry | undefined> {
	const all = await listEligible(pi, signal);
	return all[0];
}

/**
 *   "#42 critical — Issue title"
 */
export function formatIssueLabel(issue: IssueListEntry | IssueDetail): string {
	const priority = issue.priority ? ` ${issue.priority}` : "";
	return `#${issue.id}${priority} — ${issue.title}`;
}
