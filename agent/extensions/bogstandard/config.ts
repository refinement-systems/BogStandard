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

export interface FileConfig {
	database_url?: string;
	agent_id?: string;
	stale_lock_timeout_minutes?: number;
}

export interface ResolvedConfig {
	databaseUrl: string;
	agentId: string;
	staleLockTimeoutMinutes: number;
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

	return { databaseUrl, agentId, staleLockTimeoutMinutes };
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
