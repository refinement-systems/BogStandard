import { describe, expect, it } from "vitest";
import type { IssueDetail, IssueListEntry } from "../agent/extensions/bogstandard/chainlink.js";
import {
	formatIssueLabel,
	listEligible,
	pickFirstEligible,
} from "../agent/extensions/bogstandard/issue-picker.js";

/**
 * Build a minimal mock pi whose exec() stubs out chainlink issue list and show.
 */
function makePi(listItems: IssueListEntry[], detailsMap: Map<number, Partial<IssueDetail>>) {
	return {
		exec: async (cmd: string, args: string[]) => {
			if (cmd !== "chainlink") return { code: 1, stdout: "", stderr: `unexpected cmd: ${cmd}` };
			if (args[1] === "list") {
				return { code: 0, stdout: JSON.stringify(listItems), stderr: "" };
			}
			if (args[1] === "show") {
				const id = Number.parseInt(args[2], 10);
				const detail = detailsMap.get(id);
				if (!detail) return { code: 1, stdout: "", stderr: `not found: ${id}` };
				const full: IssueDetail = { id, title: `Issue ${id}`, status: "open", ...detail };
				return { code: 0, stdout: JSON.stringify(full), stderr: "" };
			}
			return { code: 1, stdout: "", stderr: `unknown args: ${args.join(" ")}` };
		},
	};
}

describe("formatIssueLabel", () => {
	it("formats id and title without priority", () => {
		expect(formatIssueLabel({ id: 5, title: "Fix bug", status: "open" })).toBe("#5 — Fix bug");
	});

	it("includes priority when present", () => {
		expect(formatIssueLabel({ id: 3, title: "Thing", status: "open", priority: "critical" })).toBe(
			"#3 critical — Thing",
		);
	});
});

describe("pickFirstEligible", () => {
	it("returns undefined when there are no open issues", async () => {
		const pi = makePi([], new Map());
		expect(await pickFirstEligible(pi as any)).toBeUndefined();
	});

	it("returns undefined when all issues are closed", async () => {
		const pi = makePi([{ id: 1, title: "Closed", status: "closed" }], new Map());
		expect(await pickFirstEligible(pi as any)).toBeUndefined();
	});

	it("returns the only eligible open issue", async () => {
		const pi = makePi(
			[{ id: 1, title: "A", status: "open" }],
			new Map([[1, { subissues: [], blocked_by: [] }]]),
		);
		expect((await pickFirstEligible(pi as any))?.id).toBe(1);
	});

	it("skips an issue with an open subissue", async () => {
		const pi = makePi(
			[{ id: 2, title: "Parent", status: "open" }],
			new Map([[2, { subissues: [{ id: 3, status: "open" }] }]]),
		);
		expect(await pickFirstEligible(pi as any)).toBeUndefined();
	});

	it("includes an issue whose only subissue is closed", async () => {
		const pi = makePi(
			[{ id: 4, title: "Done subs", status: "open" }],
			new Map([[4, { subissues: [{ id: 5, status: "closed" }] }]]),
		);
		expect((await pickFirstEligible(pi as any))?.id).toBe(4);
	});

	it("skips an issue blocked by an open issue", async () => {
		const pi = makePi(
			[{ id: 6, title: "Blocked", status: "open" }],
			new Map([
				[6, { blocked_by: [7] }],
				[7, { status: "open" }],
			]),
		);
		expect(await pickFirstEligible(pi as any)).toBeUndefined();
	});

	it("includes an issue whose blocker is closed", async () => {
		const pi = makePi(
			[{ id: 8, title: "Unblocked", status: "open" }],
			new Map([
				[8, { blocked_by: [9] }],
				[9, { status: "closed" }],
			]),
		);
		expect((await pickFirstEligible(pi as any))?.id).toBe(8);
	});

	it("picks critical before high before medium before low", async () => {
		const list: IssueListEntry[] = [
			{ id: 10, title: "Low", status: "open", priority: "low" },
			{ id: 11, title: "Critical", status: "open", priority: "critical" },
			{ id: 12, title: "Medium", status: "open", priority: "medium" },
		];
		const pi = makePi(list, new Map([[10, {}], [11, {}], [12, {}]]));
		expect((await pickFirstEligible(pi as any))?.id).toBe(11);
	});

	it("breaks priority ties by id ascending", async () => {
		const list: IssueListEntry[] = [
			{ id: 20, title: "High B", status: "open", priority: "high" },
			{ id: 15, title: "High A", status: "open", priority: "high" },
		];
		const pi = makePi(list, new Map([[15, {}], [20, {}]]));
		expect((await pickFirstEligible(pi as any))?.id).toBe(15);
	});

	it("treats unknown priority as lower than any known priority", async () => {
		const list: IssueListEntry[] = [
			{ id: 30, title: "Unknown prio", status: "open" },
			{ id: 31, title: "Low", status: "open", priority: "low" },
		];
		const pi = makePi(list, new Map([[30, {}], [31, {}]]));
		expect((await pickFirstEligible(pi as any))?.id).toBe(31);
	});
});

describe("listEligible", () => {
	it("returns all eligible issues sorted by priority then id", async () => {
		const list: IssueListEntry[] = [
			{ id: 30, title: "Low", status: "open", priority: "low" },
			{ id: 31, title: "Critical A", status: "open", priority: "critical" },
			{ id: 32, title: "Critical B", status: "open", priority: "critical" },
			{ id: 33, title: "Closed", status: "closed" },
		];
		const pi = makePi(list, new Map([[30, {}], [31, {}], [32, {}]]));
		const result = await listEligible(pi as any);
		expect(result.map((i) => i.id)).toEqual([31, 32, 30]);
	});

	it("excludes ineligible issues from the list", async () => {
		const list: IssueListEntry[] = [
			{ id: 40, title: "Blocked", status: "open" },
			{ id: 41, title: "Clear", status: "open" },
		];
		const pi = makePi(
			list,
			new Map([
				[40, { blocked_by: [99] }],
				[41, {}],
				[99, { status: "open" }],
			]),
		);
		const result = await listEligible(pi as any);
		expect(result.map((i) => i.id)).toEqual([41]);
	});

	it("returns empty array when no issues are eligible", async () => {
		const list: IssueListEntry[] = [{ id: 50, title: "Has open sub", status: "open" }];
		const pi = makePi(list, new Map([[50, { subissues: [{ id: 51, status: "open" }] }]]));
		expect(await listEligible(pi as any)).toEqual([]);
	});
});
