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
import type { IssueListEntry, Phase } from "../agent/extensions/bogstandard/db.js";
import {
	ELIGIBLE_SQL,
	type QueryRunner,
	formatIssueLabel,
	listEligibleWith,
} from "../agent/extensions/bogstandard/issue-picker.js";

interface Row {
	id: number;
	title: string;
	priority: string;
	phase: Phase;
	needs_tests: boolean | null;
}

function runnerReturning(rows: Row[]): QueryRunner & { lastSql?: string; lastParams?: unknown[] } {
	const runner: QueryRunner & { lastSql?: string; lastParams?: unknown[] } = {
		async query<R extends Record<string, unknown>>(text: string, params?: unknown[]) {
			runner.lastSql = text;
			runner.lastParams = params;
			return { rows: rows as unknown as R[] };
		},
	};
	return runner;
}

describe("formatIssueLabel", () => {
	it("formats id and title without priority", () => {
		expect(formatIssueLabel({ id: 5, title: "Fix bug", phase: "ready" })).toBe("#5 — Fix bug");
	});

	it("includes priority when present", () => {
		expect(
			formatIssueLabel({ id: 3, title: "Thing", phase: "ready", priority: "critical" }),
		).toBe("#3 critical — Thing");
	});
});

describe("listEligibleWith", () => {
	it("uses the canonical eligibility SQL", async () => {
		const runner = runnerReturning([]);
		await listEligibleWith(runner, 60);
		expect(runner.lastSql).toBe(ELIGIBLE_SQL);
	});

	it("passes the stale-lock timeout as the only param", async () => {
		const runner = runnerReturning([]);
		await listEligibleWith(runner, 45);
		expect(runner.lastParams).toEqual([45]);
	});

	it("eligibility SQL filters by phase = 'ready'", () => {
		expect(ELIGIBLE_SQL).toMatch(/i\.phase\s*=\s*'ready'/);
	});

	it("eligibility SQL requires needs_tests IS NOT NULL", () => {
		expect(ELIGIBLE_SQL).toMatch(/needs_tests IS NOT NULL/);
	});

	it("eligibility SQL excludes claimed-and-fresh issues", () => {
		expect(ELIGIBLE_SQL).toMatch(/current_agent_id IS NULL/);
		expect(ELIGIBLE_SQL).toMatch(/phase_started_at/);
	});

	it("eligibility SQL treats aborted blockers as still blocking", () => {
		// "NOT IN ('done', 'archived')" — aborted is intentionally absent
		expect(ELIGIBLE_SQL).toMatch(/phase NOT IN \('done', 'archived'\)/);
	});

	it("maps row.id to a number even when pg returns a bigint string", async () => {
		const runner = runnerReturning([
			{ id: "42" as unknown as number, title: "T", priority: "high", phase: "ready", needs_tests: true },
		]);
		const out = await listEligibleWith(runner, 60);
		expect(out).toEqual([{ id: 42, title: "T", priority: "high", phase: "ready", status: "ready" }]);
	});

	it("returns rows in the order the runner yielded them", async () => {
		const rows: Row[] = [
			{ id: 11, title: "Critical", priority: "critical", phase: "ready", needs_tests: true },
			{ id: 12, title: "Medium", priority: "medium", phase: "ready", needs_tests: false },
			{ id: 10, title: "Low", priority: "low", phase: "ready", needs_tests: true },
		];
		const out: IssueListEntry[] = await listEligibleWith(runnerReturning(rows), 60);
		expect(out.map((r) => r.id)).toEqual([11, 12, 10]);
	});

	it("returns empty array when the runner yields no rows", async () => {
		expect(await listEligibleWith(runnerReturning([]), 60)).toEqual([]);
	});
});
