import { describe, expect, it } from "vitest";
import type { IssueListEntry } from "../agent/extensions/bogstandard/db.js";
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
	status: string;
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
		expect(formatIssueLabel({ id: 5, title: "Fix bug", status: "open" })).toBe("#5 — Fix bug");
	});

	it("includes priority when present", () => {
		expect(
			formatIssueLabel({ id: 3, title: "Thing", status: "open", priority: "critical" }),
		).toBe("#3 critical — Thing");
	});
});

describe("listEligibleWith", () => {
	it("uses the canonical eligibility SQL", async () => {
		const runner = runnerReturning([]);
		await listEligibleWith(runner);
		expect(runner.lastSql).toBe(ELIGIBLE_SQL);
	});

	it("maps row.id to a number even when pg returns a bigint string", async () => {
		const runner = runnerReturning([
			{ id: "42" as unknown as number, title: "T", priority: "high", status: "open" },
		]);
		const out = await listEligibleWith(runner);
		expect(out).toEqual([{ id: 42, title: "T", priority: "high", status: "open" }]);
	});

	it("returns rows in the order the runner yielded them", async () => {
		const rows: Row[] = [
			{ id: 11, title: "Critical", priority: "critical", status: "open" },
			{ id: 12, title: "Medium", priority: "medium", status: "open" },
			{ id: 10, title: "Low", priority: "low", status: "open" },
		];
		const out: IssueListEntry[] = await listEligibleWith(runnerReturning(rows));
		expect(out.map((r) => r.id)).toEqual([11, 12, 10]);
	});

	it("returns empty array when the runner yields no rows", async () => {
		expect(await listEligibleWith(runnerReturning([]))).toEqual([]);
	});
});
