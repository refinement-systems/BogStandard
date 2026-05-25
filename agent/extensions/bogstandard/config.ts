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
 * Configuration resolution for the BogStandard postgres backend.
 *
 * Three sources, listed from highest precedence to lowest:
 *   1. CLI flags (--bs-database-url, --bs-agent-id)
 *   2. Environment variables (BOGSTANDARD_DATABASE_URL, BOGSTANDARD_AGENT_ID)
 *   3. .bogstandard/config.json in the project root
 *
 * The pure `resolveConfig` function takes all three as explicit arguments so
 * unit tests can exercise precedence without touching disk or env. The
 * `loadConfig` wrapper bundles disk + env reading for callers (scripts and
 * the extension).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_STALE_LOCK_TIMEOUT_MINUTES = 60;
export const DEFAULT_MERGE_STAGING_WORKTREE = ".bogstandard/merge-staging";
export const DEFAULT_MERGE_TEST_TIMEOUT_SECONDS = 600;

/**
 * Merge-flow configuration. Consumed by `bs-merge-worker`; the rest of the
 * stack only carries it through. All fields are optional in the file so
 * non-merge callers don't need to construct one; the daemon enforces
 * `test_command` presence at startup.
 */
export interface MergeFileConfig {
	test_command?: string[];
	test_timeout_seconds?: number;
	staging_worktree?: string;
	repair_model?: string;
}

export interface MergeConfig {
	/** Undefined if the file's `merge` block omitted `test_command`. Daemon asserts. */
	testCommand?: string[];
	testTimeoutSeconds: number;
	stagingWorktree: string;
	repairModel?: string;
}

export interface FileConfig {
	database_url?: string;
	agent_id?: string;
	stale_lock_timeout_minutes?: number;
	merge?: MergeFileConfig;
}

export interface ResolvedConfig {
	databaseUrl: string;
	agentId: string;
	staleLockTimeoutMinutes: number;
	/**
	 * Optional at the type level so non-merge callers (the orchestrator, the
	 * Designer, setup) don't need to construct one in tests. `bs-merge-worker`
	 * asserts presence (and a non-empty test_command) at startup.
	 */
	merge?: MergeConfig;
}

export interface ConfigSources {
	flagDatabaseUrl?: string;
	flagAgentId?: string;
	env?: { BOGSTANDARD_DATABASE_URL?: string; BOGSTANDARD_AGENT_ID?: string };
	file?: FileConfig;
}

/**
 * Pure resolver: combine flag → env → file. Throws if no database URL is
 * reachable through any source.
 */
export function resolveConfig(sources: ConfigSources): ResolvedConfig {
	const env = sources.env ?? {};
	const file = sources.file ?? {};

	const databaseUrl =
		sources.flagDatabaseUrl ?? env.BOGSTANDARD_DATABASE_URL ?? file.database_url;
	if (!databaseUrl || databaseUrl.trim() === "") {
		throw new Error(
			"No postgres connection configured. Set --bs-database-url, BOGSTANDARD_DATABASE_URL, or .bogstandard/config.json.",
		);
	}

	const agentId =
		sources.flagAgentId ?? env.BOGSTANDARD_AGENT_ID ?? file.agent_id ?? DEFAULT_AGENT_ID;

	const staleLockTimeoutMinutes =
		file.stale_lock_timeout_minutes ?? DEFAULT_STALE_LOCK_TIMEOUT_MINUTES;

	const resolved: ResolvedConfig = { databaseUrl, agentId, staleLockTimeoutMinutes };
	if (file.merge !== undefined) {
		resolved.merge = {
			testCommand: file.merge.test_command,
			testTimeoutSeconds: file.merge.test_timeout_seconds ?? DEFAULT_MERGE_TEST_TIMEOUT_SECONDS,
			stagingWorktree: file.merge.staging_worktree ?? DEFAULT_MERGE_STAGING_WORKTREE,
			repairModel: file.merge.repair_model,
		};
	}
	return resolved;
}

/**
 * Read .bogstandard/config.json from disk. Returns an empty object if the
 * file is missing — falling back to env/flag is fine.
 */
export function readConfigFile(projectRoot: string): FileConfig {
	const path = resolve(projectRoot, ".bogstandard", "config.json");
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as FileConfig;
		}
		return {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

/**
 * Convenience: read file + env, combine with caller-supplied flag values.
 * Used by scripts (which read process.env directly) and by the extension
 * (which passes pi.getFlag values for the flag parameters).
 */
export function loadConfig(opts: {
	projectRoot: string;
	flagDatabaseUrl?: string;
	flagAgentId?: string;
}): ResolvedConfig {
	const file = readConfigFile(opts.projectRoot);
	return resolveConfig({
		flagDatabaseUrl: opts.flagDatabaseUrl,
		flagAgentId: opts.flagAgentId,
		env: {
			BOGSTANDARD_DATABASE_URL: process.env.BOGSTANDARD_DATABASE_URL,
			BOGSTANDARD_AGENT_ID: process.env.BOGSTANDARD_AGENT_ID,
		},
		file,
	});
}
