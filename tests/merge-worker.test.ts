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
 * Unit tests for the pure helpers consumed by `scripts/run-merge-worker.ts`.
 *
 * The CLI-side wiring (startup, signal handlers, exec) lives
 * in the integration test file; here we only cover deterministic logic
 * that doesn't need a database or git.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
	assertMergeConfig,
	findAttachedMainWorktrees,
	isStagingWorktreeRegistered,
	parseWorktreesPorcelain,
	stagingWorktreeMissingMessage,
} from "../scripts/lib/merge-worker.js";
import type { ResolvedConfig } from "../agent/extensions/bogstandard/config.js";

const baseCfg: ResolvedConfig = {
	databaseUrl: "postgres://localhost/bs_test",
	agentId: "main",
	staleLockTimeoutMinutes: 60,
};

// ── parseWorktreesPorcelain ─────────────────────────────────────────────────

describe("parseWorktreesPorcelain", () => {
	it("parses a three-worktree fixture (main + branched + detached)", () => {
		const stdout = [
			"worktree /repo",
			"HEAD a1b2c3d4",
			"branch refs/heads/main",
			"",
			"worktree /repo/.bogstandard/worker-1",
			"HEAD ee11ee22",
			"branch refs/heads/bogstandard/worker-1/issue-42",
			"",
			"worktree /repo/.bogstandard/merge-staging",
			"HEAD a1b2c3d4",
			"detached",
			"",
		].join("\n");
		const entries = parseWorktreesPorcelain(stdout);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual({
			path: "/repo",
			head: "a1b2c3d4",
			branch: "refs/heads/main",
			detached: false,
		});
		expect(entries[1]).toEqual({
			path: "/repo/.bogstandard/worker-1",
			head: "ee11ee22",
			branch: "refs/heads/bogstandard/worker-1/issue-42",
			detached: false,
		});
		expect(entries[2]).toEqual({
			path: "/repo/.bogstandard/merge-staging",
			head: "a1b2c3d4",
			detached: true,
		});
	});

	it("tolerates a trailing newline-less block (no terminating blank line)", () => {
		const stdout = "worktree /repo\nHEAD a1\nbranch refs/heads/main";
		const entries = parseWorktreesPorcelain(stdout);
		expect(entries).toEqual([
			{ path: "/repo", head: "a1", branch: "refs/heads/main", detached: false },
		]);
	});

	it("tolerates CR-LF line endings", () => {
		const stdout = "worktree /repo\r\nHEAD a1\r\nbranch refs/heads/main\r\n\r\n";
		const entries = parseWorktreesPorcelain(stdout);
		expect(entries).toEqual([
			{ path: "/repo", head: "a1", branch: "refs/heads/main", detached: false },
		]);
	});

	it("returns an empty array for empty input", () => {
		expect(parseWorktreesPorcelain("")).toEqual([]);
		expect(parseWorktreesPorcelain("\n\n")).toEqual([]);
	});
});

// ── isStagingWorktreeRegistered ─────────────────────────────────────────────

describe("isStagingWorktreeRegistered", () => {
	const projectRoot = "/repo";
	const stagingAbs = "/repo/.bogstandard/merge-staging";

	const sample = [
		{ path: "/repo", detached: false },
		{ path: stagingAbs, detached: true },
	];

	it("matches when staging path is configured relative", () => {
		expect(
			isStagingWorktreeRegistered(sample, ".bogstandard/merge-staging", projectRoot),
		).toBe(true);
	});

	it("matches when staging path is configured absolute", () => {
		expect(isStagingWorktreeRegistered(sample, stagingAbs, projectRoot)).toBe(true);
	});

	it("normalises porcelain entries with redundant separators", () => {
		const noisy = [{ path: "/repo/.bogstandard/./merge-staging", detached: true }];
		expect(
			isStagingWorktreeRegistered(noisy, ".bogstandard/merge-staging", projectRoot),
		).toBe(true);
	});

	it("returns false when no entry resolves to the staging path", () => {
		const onlyMain = [{ path: "/repo", detached: false }];
		expect(
			isStagingWorktreeRegistered(onlyMain, ".bogstandard/merge-staging", projectRoot),
		).toBe(false);
	});
});

// ── findAttachedMainWorktrees ────────────────────────────────────────────────

describe("findAttachedMainWorktrees", () => {
	const projectRoot = "/repo";
	const stagingAbs = "/repo/.bogstandard/merge-staging";

	it("detects non-staging worktrees attached to refs/heads/main", () => {
		const entries = [
			{ path: "/repo", branch: "refs/heads/main", detached: false },
			{
				path: "/repo/.bogstandard/worker-1",
				branch: "refs/heads/bogstandard/worker-1",
				detached: false,
			},
			{ path: stagingAbs, detached: true },
		];

		expect(
			findAttachedMainWorktrees(entries, ".bogstandard/merge-staging", projectRoot),
		).toEqual([{ path: "/repo", branch: "refs/heads/main", detached: false }]);
	});

	it("excludes the merge-staging worktree even if it has main attached", () => {
		const entries = [
			{ path: stagingAbs, branch: "refs/heads/main", detached: false },
		];

		expect(
			findAttachedMainWorktrees(entries, ".bogstandard/merge-staging", projectRoot),
		).toEqual([]);
	});

	it("returns no candidates when main is detached or absent", () => {
		const entries = [
			{ path: "/repo", head: "abc123", detached: true },
			{ path: "/repo/feature", branch: "refs/heads/feature", detached: false },
		];

		expect(
			findAttachedMainWorktrees(entries, ".bogstandard/merge-staging", projectRoot),
		).toEqual([]);
	});
});

// ── assertMergeConfig ───────────────────────────────────────────────────────

describe("assertMergeConfig", () => {
	const configPath = "/proj/.bogstandard/config.json";

	it("throws when the merge block is absent and names the config path", () => {
		expect(() => assertMergeConfig(baseCfg, configPath)).toThrow(configPath);
		expect(() => assertMergeConfig(baseCfg, configPath)).toThrow(/no "merge" block/);
	});

	it("throws when test_command is missing", () => {
		const cfg: ResolvedConfig = {
			...baseCfg,
			merge: {
				testCommand: undefined,
				testTimeoutSeconds: 600,
				stagingWorktree: ".bogstandard/merge-staging",
				repairModel: undefined,
			},
		};
		expect(() => assertMergeConfig(cfg, configPath)).toThrow(/test_command/);
		expect(() => assertMergeConfig(cfg, configPath)).toThrow(configPath);
	});

	it("throws when test_command is an empty array", () => {
		const cfg: ResolvedConfig = {
			...baseCfg,
			merge: {
				testCommand: [],
				testTimeoutSeconds: 600,
				stagingWorktree: ".bogstandard/merge-staging",
				repairModel: undefined,
			},
		};
		expect(() => assertMergeConfig(cfg, configPath)).toThrow(/test_command/);
	});

	it("returns the narrowed config when all fields are present", () => {
		const cfg: ResolvedConfig = {
			...baseCfg,
			merge: {
				testCommand: ["npm", "test"],
				testTimeoutSeconds: 600,
				stagingWorktree: ".bogstandard/merge-staging",
				repairModel: "test/repair",
			},
		};
		expect(assertMergeConfig(cfg, configPath)).toEqual({
			testCommand: ["npm", "test"],
			testTimeoutSeconds: 600,
			stagingWorktree: ".bogstandard/merge-staging",
			repairModel: "test/repair",
		});
	});
});

// ── stagingWorktreeMissingMessage ───────────────────────────────────────────

describe("stagingWorktreeMissingMessage", () => {
	it("includes the absolute path and the remediation command", () => {
		const msg = stagingWorktreeMissingMessage(resolve("/proj/.bogstandard/merge-staging"));
		expect(msg).toContain("/proj/.bogstandard/merge-staging");
		expect(msg).toContain("git worktree add --detach");
	});
});
