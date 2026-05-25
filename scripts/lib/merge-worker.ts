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
 * Pure helpers for bs-merge-worker startup checks.
 *
 * Kept separate from `scripts/run-merge-worker.ts` so unit tests can
 * import these without dragging in the CLI module's process-level startup
 * or process-level signal handlers.
 */

import { resolve } from "node:path";
import type { ResolvedConfig } from "../../agent/extensions/bogstandard/config.js";

export interface WorktreeEntry {
	/** Absolute path as reported by `git worktree list --porcelain`. */
	path: string;
	/** Commit SHA at HEAD, if reported. */
	head?: string;
	/** Branch ref (e.g. `refs/heads/main`), if attached. */
	branch?: string;
	detached: boolean;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Each worktree block starts with a `worktree <abs-path>` line and is
 * terminated by a blank line. Inside, `HEAD <sha>`, `branch <ref>`, and
 * the standalone `detached` marker may appear. Lines we don't recognise
 * are ignored — porcelain v1 promises stability for the keys we use.
 */
export function parseWorktreesPorcelain(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;

	const flush = () => {
		if (current !== null) {
			entries.push(current);
			current = null;
		}
	};

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			flush();
			current = { path: line.slice("worktree ".length), detached: false };
			continue;
		}
		if (current === null) continue;
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length);
		} else if (line === "detached") {
			current.detached = true;
		}
	}
	flush();
	return entries;
}

/**
 * Return true iff any worktree entry's path resolves to the same
 * absolute path as `stagingPath` (resolved against `projectRoot`).
 *
 * Porcelain output is always absolute, but configs are typically
 * relative (`.bogstandard/merge-staging`); resolve both sides so the
 * comparison is independent of which form was given.
 */
export function isStagingWorktreeRegistered(
	entries: WorktreeEntry[],
	stagingPath: string,
	projectRoot: string,
): boolean {
	const target = resolve(projectRoot, stagingPath);
	return entries.some((entry) => resolve(entry.path) === target);
}

/**
 * Return non-staging worktrees that have `main` attached.
 *
 * The merge daemon runs the merge in a detached staging worktree. Any other
 * checkout attached to `refs/heads/main` can be left with a stale index and
 * working tree after the daemon advances the branch ref, so finalization needs
 * to sync those paths explicitly.
 */
export function findAttachedMainWorktrees(
	entries: WorktreeEntry[],
	stagingPath: string,
	projectRoot: string,
): WorktreeEntry[] {
	const stagingTarget = resolve(projectRoot, stagingPath);
	return entries.filter(
		(entry) =>
			entry.branch === "refs/heads/main" &&
			!entry.detached &&
			resolve(entry.path) !== stagingTarget,
	);
}

export interface AssertedMergeConfig {
	testCommand: string[];
	testTimeoutSeconds: number;
	stagingWorktree: string;
	repairModel?: string;
}

/**
 * Narrow a `ResolvedConfig` to the merge-required shape, or throw a
 * message that names the config file path so the operator can fix it
 * without grepping the source.
 */
export function assertMergeConfig(
	cfg: ResolvedConfig,
	configPath: string,
): AssertedMergeConfig {
	if (!cfg.merge) {
		throw new Error(
			`bs-merge-worker: no "merge" block in ${configPath}. Add a "merge.test_command" array, e.g. ["npm","test"].`,
		);
	}
	const { testCommand, testTimeoutSeconds, stagingWorktree, repairModel } = cfg.merge;
	if (!testCommand || testCommand.length === 0) {
		throw new Error(
			`bs-merge-worker: "merge.test_command" is missing or empty in ${configPath}. ` +
				`Set it to the command the daemon should run before and after each merge, e.g. ["npm","test"].`,
		);
	}
	return {
		testCommand,
		testTimeoutSeconds,
		stagingWorktree,
		repairModel,
	};
}

/**
 * Build the actionable error message used when the staging worktree is
 * absent. Kept as a function so the integration test can match against
 * the exact remediation hint.
 */
export function stagingWorktreeMissingMessage(absStagingPath: string): string {
	return (
		`bs-merge-worker: staging worktree not found at ${absStagingPath}. ` +
		`Run \`git worktree add --detach ${absStagingPath} main\` from the repo root, then re-run bs-merge-worker.`
	);
}
