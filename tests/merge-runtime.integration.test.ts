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
 * Integration tests for the bespoke merge runtime. These exercise the
 * `merge_tasks` / `merge_task_steps` schema and the step-replay semantics
 * against a real postgres database.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "../agent/extensions/bogstandard/db.js";
import {
	enqueueMergeTask,
	type MergeTaskParams,
} from "../agent/extensions/bogstandard/merge-queue.js";
import {
	runOnce,
	type MergeTaskContext,
	type StepHandle,
} from "../scripts/lib/merge-runtime.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";

async function clearMergeTables(): Promise<void> {
	await getPool().query(
		`TRUNCATE merge_task_steps, merge_tasks RESTART IDENTITY CASCADE`,
	);
}

describe.skipIf(!isPostgresAvailable())("merge-queue: enqueueMergeTask", () => {
	useTempDb();

	beforeEach(clearMergeTables);

	it("inserts a pending row keyed by idempotency_key", async () => {
		const result = await enqueueMergeTask(getPool(), {
			issueId: 7,
			idempotencyKey: "merge:7",
		});
		expect(result.created).toBe(true);

		const row = await getPool().query<{
			state: string;
			params: MergeTaskParams;
			idempotency_key: string;
		}>(
			`SELECT state, params, idempotency_key
			   FROM merge_tasks WHERE id = $1`,
			[result.id],
		);
		expect(row.rows[0]).toEqual({
			state: "pending",
			params: { issueId: 7 },
			idempotency_key: "merge:7",
		});
	});

	it("is idempotent on idempotency_key — second call returns the same id with created=false", async () => {
		const first = await enqueueMergeTask(getPool(), {
			issueId: 7,
			idempotencyKey: "merge:7",
		});
		const second = await enqueueMergeTask(getPool(), {
			issueId: 7,
			idempotencyKey: "merge:7",
		});
		expect(second.id).toBe(first.id);
		expect(second.created).toBe(false);

		const count = await getPool().query<{ n: string }>(
			`SELECT count(*)::text AS n FROM merge_tasks WHERE idempotency_key = $1`,
			["merge:7"],
		);
		expect(count.rows[0].n).toBe("1");
	});

	it("stores repairModel in params when provided", async () => {
		const r = await enqueueMergeTask(getPool(), {
			issueId: 9,
			repairModel: "anthropic/claude-opus-4-7",
			idempotencyKey: "merge:9",
		});
		const row = await getPool().query<{ params: MergeTaskParams }>(
			`SELECT params FROM merge_tasks WHERE id = $1`,
			[r.id],
		);
		expect(row.rows[0].params).toEqual({
			issueId: 9,
			repairModel: "anthropic/claude-opus-4-7",
		});
	});
});

describe.skipIf(!isPostgresAvailable())("merge-runtime: ctx.step", () => {
	useTempDb();

	beforeEach(clearMergeTables);

	it("runs the function on first call, skips on second, replays the stored value", async () => {
		let calls = 0;
		const handler = async (_params: MergeTaskParams, ctx: MergeTaskContext) => {
			await ctx.step("only-once", async () => {
				calls++;
				return { sentinel: "first-run" };
			});
		};

		// First run: handler should execute, step writes a row.
		await enqueueMergeTask(getPool(), { issueId: 1, idempotencyKey: "merge:1" });
		await runOnce({ pool: getPool(), handler, workerId: "w" });
		expect(calls).toBe(1);

		// Simulate "crash before COMMIT": reset state to pending so the next
		// claim picks it up, and assert step replays without re-running fn.
		await getPool().query(
			`UPDATE merge_tasks SET state='pending', completed_at=NULL WHERE idempotency_key='merge:1'`,
		);

		let replayValue: unknown;
		const handler2 = async (_params: MergeTaskParams, ctx: MergeTaskContext) => {
			replayValue = await ctx.step("only-once", async () => {
				calls++;
				return { sentinel: "second-run" };
			});
		};
		await runOnce({ pool: getPool(), handler: handler2, workerId: "w" });
		expect(calls).toBe(1); // fn did not re-run
		expect(replayValue).toEqual({ sentinel: "first-run" });
	});

	it("persists step values in merge_task_steps under seq=0", async () => {
		await enqueueMergeTask(getPool(), { issueId: 2, idempotencyKey: "merge:2" });
		await runOnce({
			pool: getPool(),
			handler: async (_p, ctx) => {
				await ctx.step("hello", async () => ({ a: 1 }));
				await ctx.step("world", async () => ({ b: 2 }));
			},
			workerId: "w",
		});

		const rows = await getPool().query<{
			name: string;
			seq: number;
			value: unknown;
		}>(`SELECT name, seq, value FROM merge_task_steps ORDER BY name`);
		expect(rows.rows).toEqual([
			{ name: "hello", seq: 0, value: { a: 1 } },
			{ name: "world", seq: 0, value: { b: 2 } },
		]);
	});
});

describe.skipIf(!isPostgresAvailable())(
	"merge-runtime: beginStep / completeStep",
	() => {
		useTempDb();

		beforeEach(clearMergeTables);

		it("returns done=false on the first call and lets completeStep insert at seq=0", async () => {
			await enqueueMergeTask(getPool(), { issueId: 3, idempotencyKey: "merge:3" });
			await runOnce({
				pool: getPool(),
				handler: async (_p, ctx) => {
					const h = await ctx.beginStep<{ msg: string }>("message");
					expect(h.done).toBe(false);
					expect(h.seq).toBe(0);
					await ctx.completeStep(h, { msg: "hello" });
				},
				workerId: "w",
			});

			const rows = await getPool().query<{ seq: number; value: { msg: string } }>(
				`SELECT seq, value FROM merge_task_steps WHERE name = 'message' ORDER BY seq`,
			);
			expect(rows.rows).toEqual([{ seq: 0, value: { msg: "hello" } }]);
		});

		it("bumps seq monotonically across many beginStep+completeStep pairs", async () => {
			await enqueueMergeTask(getPool(), { issueId: 4, idempotencyKey: "merge:4" });
			await runOnce({
				pool: getPool(),
				handler: async (_p, ctx) => {
					for (let i = 0; i < 5; i++) {
						const h = await ctx.beginStep<{ i: number }>("message");
						expect(h.done).toBe(false);
						expect(h.seq).toBe(i);
						await ctx.completeStep(h, { i });
					}
				},
				workerId: "w",
			});

			const rows = await getPool().query<{ seq: number; value: { i: number } }>(
				`SELECT seq, value FROM merge_task_steps WHERE name = 'message' ORDER BY seq`,
			);
			expect(rows.rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
			expect(rows.rows.map((r) => r.value.i)).toEqual([0, 1, 2, 3, 4]);
		});

		it("replays existing seqs as done=true on a second run and resumes appending after them", async () => {
			await enqueueMergeTask(getPool(), { issueId: 5, idempotencyKey: "merge:5" });

			// First run writes seq=0,1. The handler then "crashes" by throwing
			// a transient error, leaving the task in 'pending'.
			class TransientError extends Error {}
			let phase = 1;
			await expect(
				runOnce({
					pool: getPool(),
					handler: async (_p, ctx) => {
						const h0 = await ctx.beginStep<{ i: number }>("message");
						expect(h0.done).toBe(false);
						await ctx.completeStep(h0, { i: 0 });
						const h1 = await ctx.beginStep<{ i: number }>("message");
						expect(h1.done).toBe(false);
						await ctx.completeStep(h1, { i: 1 });
						throw new TransientError("simulated crash after seq=1");
					},
					workerId: "w",
					isTransientError: (err) => err instanceof TransientError,
				}),
			).rejects.toThrow(/simulated crash/);

			const state = await getPool().query<{ state: string }>(
				`SELECT state FROM merge_tasks WHERE idempotency_key='merge:5'`,
			);
			expect(state.rows[0].state).toBe("pending"); // transient ⇒ requeued

			// Second run: replay should surface seq=0 and seq=1 as done=true,
			// then the next beginStep returns seq=2 with done=false.
			const replayed: Array<{ done: boolean; seq: number }> = [];
			await runOnce({
				pool: getPool(),
				handler: async (_p, ctx) => {
					phase = 2;
					const h0 = await ctx.beginStep<{ i: number }>("message");
					replayed.push({ done: h0.done, seq: h0.seq });
					const h1 = await ctx.beginStep<{ i: number }>("message");
					replayed.push({ done: h1.done, seq: h1.seq });
					const h2 = await ctx.beginStep<{ i: number }>("message");
					replayed.push({ done: h2.done, seq: h2.seq });
					if (!h2.done) {
						await ctx.completeStep(h2, { i: 2 });
					}
				},
				workerId: "w",
			});

			expect(phase).toBe(2);
			expect(replayed).toEqual([
				{ done: true, seq: 0 },
				{ done: true, seq: 1 },
				{ done: false, seq: 2 },
			]);

			const rows = await getPool().query<{ seq: number; value: { i: number } }>(
				`SELECT seq, value FROM merge_task_steps WHERE name='message' ORDER BY seq`,
			);
			expect(rows.rows.map((r) => r.seq)).toEqual([0, 1, 2]);
		});
	},
);

describe.skipIf(!isPostgresAvailable())("merge-runtime: runOnce", () => {
	useTempDb();

	beforeEach(clearMergeTables);

	it("returns false when the queue is empty", async () => {
		const ran = await runOnce({
			pool: getPool(),
			handler: async () => {
				throw new Error("should not run");
			},
			workerId: "w",
		});
		expect(ran).toBe(false);
	});

	it("claims one pending task, runs the handler, marks completed with attempts=1", async () => {
		await enqueueMergeTask(getPool(), { issueId: 1, idempotencyKey: "merge:1" });
		const ran = await runOnce({
			pool: getPool(),
			handler: async () => {
				/* no-op */
			},
			workerId: "w",
		});
		expect(ran).toBe(true);

		const row = await getPool().query<{
			state: string;
			attempts: number;
			started_at: Date | null;
			completed_at: Date | null;
		}>(`SELECT state, attempts, started_at, completed_at FROM merge_tasks`);
		expect(row.rows[0].state).toBe("completed");
		expect(row.rows[0].attempts).toBe(1);
		expect(row.rows[0].started_at).not.toBeNull();
		expect(row.rows[0].completed_at).not.toBeNull();
	});

	it("marks the task failed and rethrows on a non-transient error", async () => {
		await enqueueMergeTask(getPool(), { issueId: 1, idempotencyKey: "merge:1" });
		await expect(
			runOnce({
				pool: getPool(),
				handler: async () => {
					throw new Error("boom");
				},
				workerId: "w",
			}),
		).rejects.toThrow(/boom/);

		const row = await getPool().query<{ state: string; last_error: string }>(
			`SELECT state, last_error FROM merge_tasks`,
		);
		expect(row.rows[0].state).toBe("failed");
		expect(row.rows[0].last_error).toBe("boom");
	});

	it("requeues to 'pending' on a transient error per isTransientError", async () => {
		await enqueueMergeTask(getPool(), { issueId: 1, idempotencyKey: "merge:1" });
		class MainRedish extends Error {}
		await expect(
			runOnce({
				pool: getPool(),
				handler: async () => {
					throw new MainRedish("main is red");
				},
				workerId: "w",
				isTransientError: (err) => err instanceof MainRedish,
			}),
		).rejects.toThrow(/main is red/);

		const row = await getPool().query<{ state: string; attempts: number }>(
			`SELECT state, attempts FROM merge_tasks`,
		);
		expect(row.rows[0].state).toBe("pending");
		expect(row.rows[0].attempts).toBe(1);
	});

	it("does not pick up tasks in terminal states ('completed', 'failed')", async () => {
		await getPool().query(
			`INSERT INTO merge_tasks (idempotency_key, params, state) VALUES
				('merge:done',   '{"issueId":1}', 'completed'),
				('merge:failed', '{"issueId":2}', 'failed')`,
		);
		const ran = await runOnce({
			pool: getPool(),
			handler: async () => {
				throw new Error("should not run");
			},
			workerId: "w",
		});
		expect(ran).toBe(false);
	});

	it("re-claims a task already in 'running' (single-consumer crash recovery)", async () => {
		// Simulate: previous daemon claimed but crashed before completion.
		await getPool().query(
			`INSERT INTO merge_tasks (idempotency_key, params, state, attempts, started_at)
			 VALUES ('merge:crash', '{"issueId":9}', 'running', 1, now())`,
		);
		const ran = await runOnce({
			pool: getPool(),
			handler: async () => {
				/* no-op completion */
			},
			workerId: "w",
		});
		expect(ran).toBe(true);
		const row = await getPool().query<{ state: string; attempts: number }>(
			`SELECT state, attempts FROM merge_tasks WHERE idempotency_key='merge:crash'`,
		);
		expect(row.rows[0].state).toBe("completed");
		expect(row.rows[0].attempts).toBe(2);
	});
});

/**
 * SIGKILL-resume: the daemon was killed abruptly mid-handler, after writing
 * some checkpoint rows. The task is left in 'running' with steps already on
 * disk. The next daemon run must re-claim, replay the existing rows as
 * `done: true`, and resume appending from the next seq — no duplicates.
 *
 * We can't actually fork+kill a subprocess inside vitest, so we set up the
 * post-crash state directly (row in state='running', N message rows present)
 * and exercise the resume path with a fresh runOnce. This is the load-bearing
 * property the bespoke runtime owes its message-log callers.
 */
describe.skipIf(!isPostgresAvailable())(
	"merge-runtime: SIGKILL-resume of the message log",
	() => {
		useTempDb();

		beforeEach(clearMergeTables);

		it("resumes a 'running' task with pre-existing message rows, no duplicates", async () => {
			await getPool().query(
				`INSERT INTO merge_tasks (idempotency_key, params, state, attempts, started_at)
				 VALUES ('merge:sigkill', '{"issueId":99}', 'running', 1, now())`,
			);
			const idRow = await getPool().query<{ id: string }>(
				`SELECT id FROM merge_tasks WHERE idempotency_key = 'merge:sigkill'`,
			);
			const taskId = Number(idRow.rows[0].id);
			await getPool().query(
				`INSERT INTO merge_task_steps (task_id, name, seq, value) VALUES
					($1, 'message', 0, '{"i":0}'::jsonb),
					($1, 'message', 1, '{"i":1}'::jsonb),
					($1, 'message', 2, '{"i":2}'::jsonb)`,
				[taskId],
			);

			const replayed: Array<{
				done: boolean;
				seq: number;
				state?: { i: number };
			}> = [];

			const ran = await runOnce({
				pool: getPool(),
				handler: async (_p, ctx: MergeTaskContext) => {
					// Drive the same loop the repair-agent would: walk message
					// seqs until one returns done=false, then append two more.
					for (let i = 0; i < 5; i++) {
						const h: StepHandle<{ i: number }> =
							await ctx.beginStep<{ i: number }>("message");
						replayed.push({
							done: h.done,
							seq: h.seq,
							state: h.state,
						});
						if (!h.done) {
							await ctx.completeStep(h, { i });
						}
					}
				},
				workerId: "resume-test",
			});

			expect(ran).toBe(true);

			expect(replayed).toEqual([
				{ done: true, seq: 0, state: { i: 0 } },
				{ done: true, seq: 1, state: { i: 1 } },
				{ done: true, seq: 2, state: { i: 2 } },
				{ done: false, seq: 3, state: undefined },
				{ done: false, seq: 4, state: undefined },
			]);

			// Exactly one row per seq — replay did NOT insert duplicates.
			const counts = await getPool().query<{ seq: number; n: string }>(
				`SELECT seq, count(*)::text AS n
				   FROM merge_task_steps
				  WHERE task_id = $1 AND name = 'message'
				  GROUP BY seq ORDER BY seq`,
				[taskId],
			);
			expect(counts.rows.map((r) => Number(r.n))).toEqual([1, 1, 1, 1, 1]);
			expect(counts.rows.map((r) => Number(r.seq))).toEqual([0, 1, 2, 3, 4]);

			// Original values preserved for the first three; new values for 3,4.
			const values = await getPool().query<{ seq: number; value: { i: number } }>(
				`SELECT seq, value
				   FROM merge_task_steps
				  WHERE task_id = $1 AND name = 'message'
				  ORDER BY seq`,
				[taskId],
			);
			expect(values.rows.map((r) => r.value.i)).toEqual([0, 1, 2, 3, 4]);

			// Task is now completed; attempts incremented once for this resume.
			const final = await getPool().query<{ state: string; attempts: number }>(
				`SELECT state, attempts FROM merge_tasks WHERE id = $1`,
				[taskId],
			);
			expect(final.rows[0].state).toBe("completed");
			expect(final.rows[0].attempts).toBe(2);
		});
	},
);
