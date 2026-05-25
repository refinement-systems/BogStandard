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
 * Schema-touching helpers for the merge daemon's task queue.
 *
 * Two tables live here: `merge_tasks` (one row per enqueued merge, idempotent
 * on `merge:<issueId>`) and `merge_task_steps` (durable checkpoints walked by
 * the step-replay logic in `scripts/lib/merge-runtime.ts`). See migration
 * `db/migrations/0006_merge_queue.sql`.
 *
 * The worker imports `enqueueMergeTask` to hand off committed work to the
 * daemon. The daemon itself does not import this module — it uses the runtime
 * helpers in `scripts/lib/merge-runtime.ts` that touch the same tables.
 */

export const MERGE_QUEUE_NAME = "bogstandard_merge";
export const MERGE_TASK_NAME = "merge-issue";

export interface MergeQueueRunner {
	query<R extends object>(
		text: string,
		params?: unknown[],
	): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface MergeTaskParams {
	issueId: number;
	repairModel?: string;
}

export interface EnqueueMergeTaskArgs {
	issueId: number;
	repairModel?: string;
	idempotencyKey: string;
}

export interface EnqueueMergeTaskResult {
	id: number;
	created: boolean;
}

/**
 * Idempotent insert into `merge_tasks`. `INSERT … ON CONFLICT DO NOTHING`
 * returns no rows on conflict; the CTE wrapper makes the call return either
 * the newly-inserted id (created=true) or the existing row's id
 * (created=false) in a single round-trip.
 */
export const ENQUEUE_MERGE_TASK_SQL = `
	WITH ins AS (
		INSERT INTO merge_tasks (idempotency_key, params, state)
		VALUES ($1, $2::jsonb, 'pending')
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING id
	)
	SELECT id, true AS created FROM ins
	UNION ALL
	SELECT id, false AS created
	  FROM merge_tasks
	 WHERE idempotency_key = $1
	   AND NOT EXISTS (SELECT 1 FROM ins)
	LIMIT 1
`;

export async function enqueueMergeTask(
	runner: MergeQueueRunner,
	args: EnqueueMergeTaskArgs,
): Promise<EnqueueMergeTaskResult> {
	const params: MergeTaskParams =
		args.repairModel === undefined
			? { issueId: args.issueId }
			: { issueId: args.issueId, repairModel: args.repairModel };

	const res = await runner.query<{ id: string | number; created: boolean }>(
		ENQUEUE_MERGE_TASK_SQL,
		[args.idempotencyKey, JSON.stringify(params)],
	);
	const row = res.rows[0];
	if (!row) {
		throw new Error(
			`enqueueMergeTask: no row returned for idempotency_key=${args.idempotencyKey}`,
		);
	}
	return { id: Number(row.id), created: row.created };
}

export type MergeTaskState = "pending" | "running" | "completed" | "failed";

export interface MergeTaskRow {
	id: number;
	idempotency_key: string;
	params: MergeTaskParams;
	state: MergeTaskState;
	attempts: number;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
	started_at: Date | null;
	completed_at: Date | null;
}

export interface MergeTaskStepRow {
	task_id: number;
	name: string;
	seq: number;
	value: unknown;
	completed_at: Date;
}
