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
export const CURRENT_CONFIG_VERSION = 1;

export type WorkflowId = "direct" | "tdd";
export type WorkerPhase =
	| "planning"
	| "implementing"
	| "red_planning"
	| "red_impl"
	| "green_planning"
	| "green_impl";
export type ModelPhase = WorkerPhase | "merge_repair";

const WORKFLOW_IDS: readonly WorkflowId[] = ["direct", "tdd"];
const MODEL_PHASES: readonly ModelPhase[] = [
	"planning",
	"implementing",
	"red_planning",
	"red_impl",
	"green_planning",
	"green_impl",
	"merge_repair",
];
const WORKER_PHASES: readonly WorkerPhase[] = [
	"planning",
	"implementing",
	"red_planning",
	"red_impl",
	"green_planning",
	"green_impl",
];

export function workflowIdForNeedsTests(
	needsTests: boolean | null | undefined,
): WorkflowId | null {
	if (needsTests === true) return "tdd";
	if (needsTests === false) return "direct";
	return null;
}

export function needsTestsForWorkflowId(
	workflowId: WorkflowId | null | undefined,
): boolean | null {
	if (workflowId === "tdd") return true;
	if (workflowId === "direct") return false;
	return null;
}

export function assertWorkflowId(value: string): asserts value is WorkflowId {
	if (!(WORKFLOW_IDS as readonly string[]).includes(value)) {
		throw new Error(`Invalid workflow_id '${value}'. Must be one of: ${WORKFLOW_IDS.join(", ")}`);
	}
}

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

export interface WorkerModelsFileConfig {
	plan?: string;
	implement?: string;
	merge_repair?: string;
	phases?: Partial<Record<ModelPhase, string>>;
}

export interface WorkerModelsConfig {
	plan?: string;
	implement?: string;
	mergeRepair?: string;
	phases: Partial<Record<ModelPhase, string>>;
}

export interface PromptOverrideFileConfig {
	system_prepend?: string;
	system_append?: string;
	user_prepend?: string;
	user_append?: string;
}

export interface PromptOverrideConfig {
	systemPrepend?: string;
	systemAppend?: string;
	userPrepend?: string;
	userAppend?: string;
}

export interface WorkerFileConfig {
	models?: WorkerModelsFileConfig;
	prompts?: Partial<Record<WorkerPhase, PromptOverrideFileConfig>>;
}

export interface WorkerConfig {
	models: WorkerModelsConfig;
	prompts: Partial<Record<WorkerPhase, PromptOverrideConfig>>;
}

export interface FileConfig {
	config_version?: number;
	database_url?: string;
	agent_id?: string;
	stale_lock_timeout_minutes?: number;
	merge?: MergeFileConfig;
	worker?: WorkerFileConfig;
}

export interface ResolvedConfig {
	configVersion: number;
	databaseUrl: string;
	agentId: string;
	staleLockTimeoutMinutes: number;
	worker: WorkerConfig;
	/**
	 * Optional at the type level so non-merge callers (the orchestrator, the
	 * Designer, setup) don't need to construct one in tests. `bs-merge-worker`
	 * asserts presence (and a non-empty test_command) at startup.
	 */
	merge?: MergeConfig;
}

export type MinimalResolvedConfig =
	Pick<ResolvedConfig, "databaseUrl" | "agentId" | "staleLockTimeoutMinutes"> &
	Partial<Pick<ResolvedConfig, "configVersion" | "worker" | "merge">>;

export interface ConfigSources {
	flagDatabaseUrl?: string;
	flagAgentId?: string;
	env?: { BOGSTANDARD_DATABASE_URL?: string; BOGSTANDARD_AGENT_ID?: string };
	file?: FileConfig;
}

export function completeResolvedConfig(input: MinimalResolvedConfig): ResolvedConfig {
	const out: ResolvedConfig = {
		configVersion: normalizeConfigVersion(input.configVersion),
		databaseUrl: input.databaseUrl,
		agentId: input.agentId,
		staleLockTimeoutMinutes: input.staleLockTimeoutMinutes,
		worker: input.worker ?? normalizeWorkerConfig(undefined),
	};
	if (input.merge !== undefined) out.merge = input.merge;
	return out;
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

	const resolved: ResolvedConfig = {
		configVersion: normalizeConfigVersion(file.config_version),
		databaseUrl,
		agentId,
		staleLockTimeoutMinutes,
		worker: normalizeWorkerConfig(file.worker),
	};
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

function normalizeConfigVersion(value: number | undefined): number {
	if (value === undefined) return CURRENT_CONFIG_VERSION;
	if (value !== CURRENT_CONFIG_VERSION) {
		throw new Error(
			`Unsupported .bogstandard/config.json config_version ${value}; this BogStandard supports ${CURRENT_CONFIG_VERSION}.`,
		);
	}
	return value;
}

function normalizeWorkerConfig(input: WorkerFileConfig | undefined): WorkerConfig {
	return {
		models: normalizeWorkerModels(input?.models),
		prompts: normalizePromptOverrides(input?.prompts),
	};
}

function normalizeWorkerModels(input: WorkerModelsFileConfig | undefined): WorkerModelsConfig {
	const phases: Partial<Record<ModelPhase, string>> = {};
	for (const [phase, spec] of Object.entries(input?.phases ?? {})) {
		assertKnownPhase(phase, MODEL_PHASES, "worker.models.phases");
		if (spec !== undefined) phases[phase] = spec;
	}
	const out: WorkerModelsConfig = { phases };
	if (input?.plan !== undefined) out.plan = input.plan;
	if (input?.implement !== undefined) out.implement = input.implement;
	if (input?.merge_repair !== undefined) out.mergeRepair = input.merge_repair;
	return out;
}

function normalizePromptOverrides(
	input: WorkerFileConfig["prompts"] | undefined,
): WorkerConfig["prompts"] {
	const out: WorkerConfig["prompts"] = {};
	for (const [phase, override] of Object.entries(input ?? {})) {
		assertKnownPhase(phase, WORKER_PHASES, "worker.prompts");
		if (override === undefined) continue;
		out[phase] = {
			systemPrepend: override.system_prepend,
			systemAppend: override.system_append,
			userPrepend: override.user_prepend,
			userAppend: override.user_append,
		};
	}
	return out;
}

function assertKnownPhase<T extends string>(
	phase: string,
	allowed: readonly T[],
	path: string,
): asserts phase is T {
	if (!(allowed as readonly string[]).includes(phase)) {
		throw new Error(`Unknown phase '${phase}' in ${path}; expected one of: ${allowed.join(", ")}`);
	}
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
