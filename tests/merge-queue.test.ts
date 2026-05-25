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

import { describe, expect, it } from "vitest";
import {
	ENQUEUE_MERGE_TASK_SQL,
	MERGE_QUEUE_NAME,
	MERGE_TASK_NAME,
	enqueueMergeTask,
	type MergeQueueRunner,
} from "../agent/extensions/bogstandard/merge-queue.js";

describe("merge-queue constants", () => {
	it("exports the queue + task name the daemon registers against", () => {
		expect(MERGE_QUEUE_NAME).toBe("bogstandard_merge");
		expect(MERGE_TASK_NAME).toBe("merge-issue");
	});
});

describe("ENQUEUE_MERGE_TASK_SQL", () => {
	it("inserts into merge_tasks with idempotency_key, params, and 'pending' state", () => {
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(/INSERT INTO merge_tasks/);
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(
			/\(idempotency_key,\s*params,\s*state\)/,
		);
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(/VALUES\s*\(\$1,\s*\$2::jsonb,\s*'pending'\)/);
	});

	it("on conflict does nothing — the existing row's id is returned via the UNION ALL", () => {
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(/UNION ALL/);
		expect(ENQUEUE_MERGE_TASK_SQL).toMatch(
			/SELECT id, false AS created\s+FROM merge_tasks\s+WHERE idempotency_key = \$1/,
		);
	});
});

interface RecordedCall {
	sql: string;
	params: unknown[];
}

function makeMockRunner(rows: Array<{ id: number | string; created: boolean }>): {
	runner: MergeQueueRunner;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const runner: MergeQueueRunner = {
		async query(sql, params) {
			calls.push({ sql, params: params ?? [] });
			return { rows: rows as never[], rowCount: rows.length };
		},
	};
	return { runner, calls };
}

describe("enqueueMergeTask", () => {
	it("serializes params and binds them with the idempotency key", async () => {
		const { runner, calls } = makeMockRunner([{ id: 7, created: true }]);
		const result = await enqueueMergeTask(runner, {
			issueId: 42,
			idempotencyKey: "merge:42",
		});

		expect(result).toEqual({ id: 7, created: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toBe(ENQUEUE_MERGE_TASK_SQL);
		expect(calls[0].params).toEqual([
			"merge:42",
			JSON.stringify({ issueId: 42 }),
		]);
	});

	it("includes the repair model in params when provided", async () => {
		const { runner, calls } = makeMockRunner([{ id: 8, created: true }]);
		await enqueueMergeTask(runner, {
			issueId: 5,
			repairModel: "anthropic/claude-opus-4-7",
			idempotencyKey: "merge:5",
		});
		expect(calls[0].params[1]).toBe(
			JSON.stringify({ issueId: 5, repairModel: "anthropic/claude-opus-4-7" }),
		);
	});

	it("returns created=false on idempotency conflict (existing row id returned by the CTE)", async () => {
		const { runner } = makeMockRunner([{ id: 9, created: false }]);
		const result = await enqueueMergeTask(runner, {
			issueId: 11,
			idempotencyKey: "merge:11",
		});
		expect(result).toEqual({ id: 9, created: false });
	});

	it("converts string ids (pg numeric → string) to numbers", async () => {
		const { runner } = makeMockRunner([{ id: "42", created: true }]);
		const result = await enqueueMergeTask(runner, {
			issueId: 1,
			idempotencyKey: "merge:1",
		});
		expect(result.id).toBe(42);
		expect(typeof result.id).toBe("number");
	});

	it("throws if the runner returns no row (should be unreachable; defensive)", async () => {
		const { runner } = makeMockRunner([]);
		await expect(
			enqueueMergeTask(runner, { issueId: 1, idempotencyKey: "merge:1" }),
		).rejects.toThrow(/no row returned/);
	});
});
