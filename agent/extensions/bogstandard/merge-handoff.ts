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
 * Worker → merge-daemon handoff.
 *
 * The worker has just committed its implementation. This module captures
 * the head SHA, publishes it as a `refs/bogstandard/issue-<id>` ref
 * (the durable handle the merge daemon will operate on), records a row
 * in `issue_branches`, transitions the issue to `merging_pending`, and
 * enqueues a `merge-issue` task. The worker branch can then be
 * deleted — the ref is the handle.
 *
 * Step ordering matters for crash safety: the git ref is published before
 * touching Postgres, then the branch row, phase transition, phase event, and
 * the task enqueue is committed in one transaction. A failed DB handoff leaves
 * the issue in its implementation phase, so retrying is safe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	getPool,
	type Phase,
} from "./db.js";
import {
	currentBranch,
	gitBranchDelete,
	gitCheckoutDetachHead,
	gitMergeBase,
	gitUpdateRef,
	headSha,
} from "./git.js";
import {
	MERGE_QUEUE_NAME,
	MERGE_TASK_NAME,
	enqueueMergeTask,
} from "./merge-queue.js";

// Re-exported so existing imports across tests and pi.appendEntry markers
// continue to resolve to the same module they did before merge-queue.ts existed.
export { MERGE_QUEUE_NAME, MERGE_TASK_NAME };

export function refNameForIssue(issueId: number): string {
	return `refs/bogstandard/issue-${issueId}`;
}

/**
 * Decide how `closeAndCommit` should land the worker's output. The two
 * inputs are independent: the working tree may be clean simply because
 * an earlier attempt already committed (commitsAhead > 0), and a dirty
 * tree always commits regardless of how many prior commits exist.
 */
export type CloseRoute = "no_changes" | "publish_existing" | "commit_then_publish";

export function routeCloseAction(clean: boolean, commitsAhead: number): CloseRoute {
	if (!clean) return "commit_then_publish";
	return commitsAhead > 0 ? "publish_existing" : "no_changes";
}

export const UPSERT_ISSUE_BRANCH_SQL = `
	INSERT INTO issue_branches (issue_id, ref_name, head_sha, base_sha)
	VALUES ($1, $2, $3, $4)
	ON CONFLICT (issue_id) DO UPDATE
	  SET ref_name     = EXCLUDED.ref_name,
	      head_sha     = EXCLUDED.head_sha,
	      base_sha     = EXCLUDED.base_sha,
	      published_at = now(),
	      merged_at    = NULL,
	      merge_sha    = NULL
	WHERE (
	      issue_branches.ref_name = EXCLUDED.ref_name
	  AND issue_branches.head_sha = EXCLUDED.head_sha
	  AND issue_branches.base_sha = EXCLUDED.base_sha
	) OR EXISTS (
	      SELECT 1
	        FROM issues
	       WHERE issues.id = EXCLUDED.issue_id
	         AND issues.phase = $5
	)
`;

export const TRANSITION_TO_MERGING_PENDING_SQL = `
	UPDATE issues
	   SET phase = 'merging_pending',
	       phase_started_at = now(),
	       updated_at = now(),
	       current_agent_id = NULL
	 WHERE id = $1
	   AND phase = $2
	RETURNING current_version_id
`;

export const INSERT_HANDOFF_PHASE_EVENT_SQL = `
	INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata)
	     VALUES ($1, $2, $3, 'merging_pending', $4, 'implementation committed', $5)
`;

export const SELECT_HANDOFF_RETRY_SQL = `
	SELECT i.phase, i.current_version_id, ib.ref_name, ib.head_sha, ib.base_sha
	  FROM issues i
	  LEFT JOIN issue_branches ib ON ib.issue_id = i.id
	 WHERE i.id = $1
`;

export interface QueryRunner {
	query<R extends object>(
		text: string,
		params?: unknown[],
	): Promise<{ rows: R[]; rowCount?: number | null }>;
	connect?: () => Promise<QueryClient>;
}

export interface QueryClient {
	query<R extends object>(
		text: string,
		params?: unknown[],
	): Promise<{ rows: R[]; rowCount?: number | null }>;
	release?: () => void;
}

export interface PublishArgs {
	issueId: number;
	fromPhase: Phase;
	agentId: string | null;
	repairModel?: string;
}

export interface PublishDeps {
	runner: QueryRunner;
}

export interface PublishResult {
	refName: string;
	headSha: string;
	baseSha: string;
}

export async function publishWorkerBranchWith(
	pi: ExtensionAPI,
	args: PublishArgs,
	deps: PublishDeps,
): Promise<PublishResult> {
	const head = await headSha(pi);
	const base = await gitMergeBase(pi, "HEAD", "main");
	const refName = refNameForIssue(args.issueId);

	await gitUpdateRef(pi, refName, head);

	await persistMergeHandoffWith(deps.runner, {
		...args,
		refName,
		headSha: head,
		baseSha: base,
	});

	try {
		const branch = await currentBranch(pi);
		if (branch && branch.startsWith("bogstandard/")) {
			await gitCheckoutDetachHead(pi);
			await gitBranchDelete(pi, branch, true);
		}
	} catch {
		// best-effort: the ref is the durable handle; a stale worker branch is
		// merely cosmetic and is reaped by `dispatch.sh --cleanup` anyway.
	}

	return { refName, headSha: head, baseSha: base };
}

export async function publishWorkerBranch(
	pi: ExtensionAPI,
	args: PublishArgs,
): Promise<PublishResult> {
	return publishWorkerBranchWith(pi, args, {
		runner: getPool(),
	});
}

interface PersistMergeHandoffArgs extends PublishArgs {
	refName: string;
	headSha: string;
	baseSha: string;
}

interface RetryRow {
	phase: Phase;
	current_version_id: string | null;
	ref_name: string | null;
	head_sha: string | null;
	base_sha: string | null;
}

export async function persistMergeHandoffWith(
	runner: QueryRunner,
	args: PersistMergeHandoffArgs,
): Promise<void> {
	const client = await connectTransactionClient(runner);
	let committed = false;
	try {
		await client.query("BEGIN");
		await client.query(UPSERT_ISSUE_BRANCH_SQL, [
			args.issueId,
			args.refName,
			args.headSha,
			args.baseSha,
			args.fromPhase,
		]);

		const transition = await client.query<{ current_version_id: string | null }>(
			TRANSITION_TO_MERGING_PENDING_SQL,
			[args.issueId, args.fromPhase],
		);
		const transitioned = rowCountOf(transition) > 0;

		if (transitioned) {
			const versionId = transition.rows[0]?.current_version_id ?? null;
			await client.query(INSERT_HANDOFF_PHASE_EVENT_SQL, [
				args.issueId,
				versionId === null ? null : Number(versionId),
				args.fromPhase,
				args.agentId,
				JSON.stringify({
					ref_name: args.refName,
					head_sha: args.headSha,
					base_sha: args.baseSha,
				}),
			]);
		} else {
			await assertMatchingCommittedHandoff(client, args);
		}

		await enqueueMergeTask(client, {
			issueId: args.issueId,
			repairModel: args.repairModel,
			idempotencyKey: `merge:${args.issueId}`,
		});

		await client.query("COMMIT");
		committed = true;
	} catch (err) {
		if (!committed) {
			await client.query("ROLLBACK").catch(() => {});
		}
		throw err;
	} finally {
		client.release?.();
	}
}

async function connectTransactionClient(runner: QueryRunner): Promise<QueryClient> {
	if (runner.connect) {
		return runner.connect();
	}
	return runner;
}

function rowCountOf(result: { rows: unknown[]; rowCount?: number | null }): number {
	return result.rowCount ?? result.rows.length;
}

async function assertMatchingCommittedHandoff(
	client: QueryClient,
	args: PersistMergeHandoffArgs,
): Promise<void> {
	const retry = await client.query<RetryRow>(SELECT_HANDOFF_RETRY_SQL, [args.issueId]);
	const row = retry.rows[0];
	if (
		row?.phase === "merging_pending" &&
		row.ref_name === args.refName &&
		row.head_sha === args.headSha &&
		row.base_sha === args.baseSha
	) {
		return;
	}
	throw new Error(
		`Could not transition issue ${args.issueId} to 'merging_pending' (precondition failed)`,
	);
}
