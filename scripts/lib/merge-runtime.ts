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
 * Daemon-side runtime for the bespoke merge queue.
 *
 * Single-consumer assumption: do not run more than one `bs-merge-worker`
 * against the same database. Re-claiming `running` rows on daemon restart
 * is safe because the handler is resumable via step replay (`merge_task_steps`).
 *
 * The runtime implements the `TaskContext` interface
 * that BogStandard's merge handler actually uses:
 *   - `step(name, fn)`  — single-shot named checkpoint (seq=0).
 *   - `beginStep(name)` / `completeStep(handle, value)` — multi-shot, used by
 *     the repair-agent message log (one row per agent message under name='message').
 *
 * Errors thrown by the handler default to terminal (`state='failed'`). The
 * caller can supply `isTransientError` to mark specific errors as transient
 * (`state='pending'`) so the daemon picks them up again on restart.
 */

import pg from "pg";
import {
	type MergeTaskParams,
	type MergeTaskState,
} from "../../agent/extensions/bogstandard/merge-queue.js";

export interface StepHandle<T> {
	readonly name: string;
	readonly seq: number;
	readonly done: boolean;
	readonly state?: T;
}

export interface MergeTaskContext {
	step<T>(name: string, fn: () => Promise<T>): Promise<T>;
	beginStep<T>(name: string): Promise<StepHandle<T>>;
	completeStep<T>(handle: StepHandle<T>, value: T): Promise<void>;
}

export type MergeTaskHandler = (
	params: MergeTaskParams,
	ctx: MergeTaskContext,
) => Promise<void>;

export interface MergeRuntimeLog {
	log?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface RunDeps {
	pool: pg.Pool;
	handler: MergeTaskHandler;
	workerId: string;
	/**
	 * Return true if `err` should leave the task in `pending` (so the daemon
	 * picks it up again on restart). Default: every error is terminal
	 * (`state='failed'`).
	 */
	isTransientError?: (err: unknown) => boolean;
	log?: MergeRuntimeLog;
	/** Poll interval for the long-running daemon. Defaults to 1000 ms. */
	pollIntervalMs?: number;
}

interface ClaimedTask {
	id: number;
	params: MergeTaskParams;
	attempts: number;
}

class MergeTaskContextImpl implements MergeTaskContext {
	private readonly nameCounters = new Map<string, number>();

	constructor(
		private readonly pool: pg.Pool,
		private readonly taskId: number,
	) {}

	async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const existing = await this.pool.query<{ value: T }>(
			`SELECT value FROM merge_task_steps
			  WHERE task_id = $1 AND name = $2 AND seq = 0`,
			[this.taskId, name],
		);
		if (existing.rows.length > 0) {
			return existing.rows[0].value;
		}
		const value = await fn();
		await this.pool.query(
			`INSERT INTO merge_task_steps (task_id, name, seq, value)
			 VALUES ($1, $2, 0, $3::jsonb)
			 ON CONFLICT (task_id, name, seq) DO NOTHING`,
			[this.taskId, name, JSON.stringify(value ?? null)],
		);
		return value;
	}

	async beginStep<T>(name: string): Promise<StepHandle<T>> {
		const seq = this.nameCounters.get(name) ?? 0;
		const res = await this.pool.query<{ value: T }>(
			`SELECT value FROM merge_task_steps
			  WHERE task_id = $1 AND name = $2 AND seq = $3`,
			[this.taskId, name, seq],
		);
		if (res.rows.length > 0) {
			this.nameCounters.set(name, seq + 1);
			return { name, seq, done: true, state: res.rows[0].value };
		}
		return { name, seq, done: false };
	}

	async completeStep<T>(handle: StepHandle<T>, value: T): Promise<void> {
		if (handle.done) {
			throw new Error(
				`completeStep: handle for ${handle.name} seq=${handle.seq} is already done`,
			);
		}
		await this.pool.query(
			`INSERT INTO merge_task_steps (task_id, name, seq, value)
			 VALUES ($1, $2, $3, $4::jsonb)`,
			[this.taskId, handle.name, handle.seq, JSON.stringify(value ?? null)],
		);
		this.nameCounters.set(handle.name, handle.seq + 1);
	}
}

async function claimNextTask(pool: pg.Pool): Promise<ClaimedTask | undefined> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const sel = await client.query<{ id: string }>(
			`SELECT id FROM merge_tasks
			  WHERE state IN ('pending','running')
			  ORDER BY id
			  FOR UPDATE SKIP LOCKED
			  LIMIT 1`,
		);
		if (sel.rows.length === 0) {
			await client.query("COMMIT");
			return undefined;
		}
		const id = Number(sel.rows[0].id);
		const upd = await client.query<{
			params: MergeTaskParams;
			attempts: number;
		}>(
			`UPDATE merge_tasks
			    SET state = 'running',
			        attempts = attempts + 1,
			        started_at = COALESCE(started_at, now()),
			        updated_at = now()
			  WHERE id = $1
			RETURNING params, attempts`,
			[id],
		);
		await client.query("COMMIT");
		return {
			id,
			params: upd.rows[0].params,
			attempts: Number(upd.rows[0].attempts),
		};
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

async function markTaskState(
	pool: pg.Pool,
	taskId: number,
	state: MergeTaskState,
	lastError: string | null,
): Promise<void> {
	if (state === "completed") {
		await pool.query(
			`UPDATE merge_tasks
			    SET state = 'completed',
			        completed_at = now(),
			        updated_at = now(),
			        last_error = NULL
			  WHERE id = $1`,
			[taskId],
		);
		return;
	}
	if (state === "pending") {
		await pool.query(
			`UPDATE merge_tasks
			    SET state = 'pending',
			        last_error = $2,
			        updated_at = now()
			  WHERE id = $1`,
			[taskId, lastError],
		);
		return;
	}
	if (state === "failed") {
		await pool.query(
			`UPDATE merge_tasks
			    SET state = 'failed',
			        last_error = $2,
			        updated_at = now()
			  WHERE id = $1`,
			[taskId, lastError],
		);
		return;
	}
	throw new Error(`markTaskState: refusing to set state='${state}'`);
}

/**
 * Claim one task and run the handler. Returns `false` if the queue was empty
 * (nothing to do), `true` if a task was processed (regardless of outcome).
 * Re-throws the handler's error after marking the task; callers can catch and
 * inspect (e.g. to trigger daemon shutdown on `MainIsRedError`).
 */
export async function runOnce(deps: RunDeps): Promise<boolean> {
	const claimed = await claimNextTask(deps.pool);
	if (!claimed) return false;

	const ctx = new MergeTaskContextImpl(deps.pool, claimed.id);
	try {
		await deps.handler(claimed.params, ctx);
		await markTaskState(deps.pool, claimed.id, "completed", null);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const transient = deps.isTransientError?.(err) === true;
		await markTaskState(
			deps.pool,
			claimed.id,
			transient ? "pending" : "failed",
			msg,
		);
		throw err;
	}
}

export interface DaemonHandle {
	/** Resolves when the loop has fully drained and stopped. */
	close: () => Promise<void>;
	/** A promise that resolves only on internal error inside the loop wrapper. */
	exited: Promise<void>;
}

/**
 * Long-running poll loop. Calls `runOnce` until `close()` is invoked or the
 * handler throws — re-throwing is the daemon-shutdown signal in this design
 * (the caller's wrapped handler is expected to stash terminal errors before
 * re-throwing so the outer `bs-merge-worker` process can translate them to
 * exit codes).
 */
export function runDaemon(deps: RunDeps): DaemonHandle {
	let stopping = false;
	let stopResolve: () => void = () => {};
	const stopSignal = new Promise<void>((res) => {
		stopResolve = res;
	});
	const pollMs = deps.pollIntervalMs ?? 1000;

	const loop = (async () => {
		while (!stopping) {
			let didWork: boolean;
			try {
				didWork = await runOnce(deps);
			} catch (err) {
				// Handler error — task is already marked. Surface and exit the
				// loop so the caller can decide what to do (e.g. translate to
				// process exit code).
				throw err;
			}
			if (stopping) return;
			if (!didWork) {
				await Promise.race([sleep(pollMs), stopSignal]);
			}
		}
	})();

	return {
		exited: loop,
		close: async () => {
			stopping = true;
			stopResolve();
			await loop.catch(() => {});
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
