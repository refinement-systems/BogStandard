#!/usr/bin/env tsx

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
 * BogStandard one-time setup.
 *
 *   npm run setup -- --database-url postgres://localhost:5432/bogstandard_myproject \
 *                    [--agent-id main] \
 *                    [--stale-lock-timeout-minutes 60] \
 *                    [--force]
 *   npm run setup -- --upgrade-config
 *
 * What it does:
 *   1. Connects to the target database (creating it via the postgres admin DB
 *      if it doesn't exist).
 *   2. Runs db/migrations/0001_init.sql.
 *   3. Writes .bogstandard/config.json with the URL + defaults.
 *
 * Idempotent w.r.t. the schema (`CREATE TABLE IF NOT EXISTS`). Refuses to
 * overwrite an existing config.json unless --force is passed.
 *
 * --upgrade-config is a file-only path for existing projects: it fills missing
 * config defaults and preserves user-provided fields.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
	CURRENT_CONFIG_VERSION,
	DEFAULT_AGENT_ID,
	DEFAULT_MERGE_STAGING_WORKTREE,
	DEFAULT_MERGE_TEST_TIMEOUT_SECONDS,
	DEFAULT_STALE_LOCK_TIMEOUT_MINUTES,
} from "../agent/extensions/bogstandard/config.js";
import { applyMigrations } from "./lib/migrations.js";
import {
	isStagingWorktreeRegistered,
	parseWorktreesPorcelain,
} from "./lib/merge-worker.js";

const execFileP = promisify(execFile);

const { Client } = pg;

interface Args {
	databaseUrl?: string;
	agentId?: string;
	staleLockTimeoutMinutes?: number;
	force: boolean;
	upgradeConfig: boolean;
}

function parseArgs(argv: string[]): Args {
	const out: Args = { force: false, upgradeConfig: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value for ${a}`);
			return v;
		};
		switch (a) {
			case "--database-url":
				out.databaseUrl = next();
				break;
			case "--agent-id":
				out.agentId = next();
				break;
			case "--stale-lock-timeout-minutes":
				out.staleLockTimeoutMinutes = Number.parseInt(next(), 10);
				break;
			case "--force":
				out.force = true;
				break;
			case "--upgrade-config":
				out.upgradeConfig = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}
	return out;
}

function printHelp(): void {
	console.log(
		`Usage: bs-setup --database-url <url> [--agent-id <id>] [--stale-lock-timeout-minutes <n>] [--force]\n` +
			`       bs-setup --upgrade-config\n` +
			`\n` +
			`Run from the target project's directory. Writes .bogstandard/config.json there.\n` +
			`Defaults: agent-id=main, stale-lock-timeout-minutes=60.\n` +
			`The database is created automatically (via the postgres admin DB) if missing.\n` +
			`--upgrade-config only fills missing config defaults; it does not touch postgres.`,
	);
}

/** Split a postgres URL into (adminUrl, dbName). */
export function splitDatabaseUrl(url: string): { adminUrl: string; dbName: string } {
	const u = new URL(url);
	const dbName = u.pathname.replace(/^\//, "");
	if (!dbName) {
		throw new Error(`Database URL ${url} has no database name in its path`);
	}
	u.pathname = "/postgres";
	return { adminUrl: u.toString(), dbName };
}

export async function databaseExists(adminUrl: string, dbName: string): Promise<boolean> {
	const client = new Client({ connectionString: adminUrl });
	await client.connect();
	try {
		const res = await client.query<{ exists: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
			[dbName],
		);
		return res.rows[0]?.exists === true;
	} finally {
		await client.end();
	}
}

export async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
	const client = new Client({ connectionString: adminUrl });
	await client.connect();
	try {
		// pg-format-light: identifiers can't be parameterised, so we validate
		// the name with a strict regex before interpolation.
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
			throw new Error(`Refusing to CREATE DATABASE with unsafe name: ${dbName}`);
		}
		await client.query(`CREATE DATABASE "${dbName}"`);
		console.log(`Created database "${dbName}".`);
	} finally {
		await client.end();
	}
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureObjectField(parent: JsonObject, key: string, path: string): JsonObject {
	const value = parent[key];
	if (value === undefined) {
		const next: JsonObject = {};
		parent[key] = next;
		return next;
	}
	if (!isJsonObject(value)) {
		throw new Error(`${path} must be an object in .bogstandard/config.json`);
	}
	return value;
}

function configPath(projectRoot: string): string {
	return resolve(projectRoot, ".bogstandard/config.json");
}

function defaultConfigBody(args: {
	databaseUrl: string;
	agentId?: string;
	staleLockTimeoutMinutes?: number;
}): JsonObject {
	return {
		config_version: CURRENT_CONFIG_VERSION,
		database_url: args.databaseUrl,
		agent_id: args.agentId ?? DEFAULT_AGENT_ID,
		stale_lock_timeout_minutes:
			args.staleLockTimeoutMinutes ?? DEFAULT_STALE_LOCK_TIMEOUT_MINUTES,
		worker: {
			models: {
				phases: {},
			},
			prompts: {},
		},
		merge: {
			test_command: ["npm", "test"],
			test_timeout_seconds: DEFAULT_MERGE_TEST_TIMEOUT_SECONDS,
		},
	};
}

export function writeConfig(
	projectRoot: string,
	args: { databaseUrl: string; agentId?: string; staleLockTimeoutMinutes?: number },
	force: boolean,
): string {
	const dir = resolve(projectRoot, ".bogstandard");
	const path = configPath(projectRoot);
	if (existsSync(path) && !force) {
		throw new Error(
			`${path} already exists. Re-run with --force to overwrite, or edit it by hand.`,
		);
	}
	mkdirSync(dir, { recursive: true });
	const body = defaultConfigBody(args);
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
	console.log(`Wrote ${path}.`);
	console.log(
		`  ! Edit ${path} → "merge.test_command" to match this project before running bs-merge-worker.`,
	);
	console.log(
		`  ! If merge repair should run from the daemon without /bs-task model flags, set "worker.models.phases.merge_repair" explicitly.`,
	);
	return path;
}

export function upgradeConfig(projectRoot: string): string {
	const path = configPath(projectRoot);
	if (!existsSync(path)) {
		throw new Error(`${path} does not exist. Run bs-setup first to create it.`);
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isJsonObject(parsed)) {
		throw new Error(`${path} must contain a JSON object.`);
	}

	const version = parsed.config_version;
	if (version === undefined) {
		parsed.config_version = CURRENT_CONFIG_VERSION;
	} else if (version !== CURRENT_CONFIG_VERSION) {
		throw new Error(
			`Unsupported .bogstandard/config.json config_version ${String(version)}; this BogStandard supports ${CURRENT_CONFIG_VERSION}.`,
		);
	}

	if (parsed.agent_id === undefined) parsed.agent_id = DEFAULT_AGENT_ID;
	if (parsed.stale_lock_timeout_minutes === undefined) {
		parsed.stale_lock_timeout_minutes = DEFAULT_STALE_LOCK_TIMEOUT_MINUTES;
	}

	const worker = ensureObjectField(parsed, "worker", "worker");
	const models = ensureObjectField(worker, "models", "worker.models");
	ensureObjectField(models, "phases", "worker.models.phases");
	ensureObjectField(worker, "prompts", "worker.prompts");

	const merge = ensureObjectField(parsed, "merge", "merge");
	if (merge.test_command === undefined) merge.test_command = ["npm", "test"];
	if (merge.test_timeout_seconds === undefined) {
		merge.test_timeout_seconds = DEFAULT_MERGE_TEST_TIMEOUT_SECONDS;
	}

	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
	console.log(`Upgraded ${path}.`);
	console.log(
		`  ! Review "merge.test_command" before running bs-merge-worker.`,
	);
	console.log(
		`  ! Set "worker.models.phases.merge_repair" if merge repair should run from the daemon without /bs-task model flags.`,
	);
	return path;
}

export interface RunSetupOptions {
	databaseUrl: string;
	projectRoot: string;
	agentId?: string;
	staleLockTimeoutMinutes?: number;
	force?: boolean;
	migrationsDir?: string;
	log?: (msg: string) => void;
	/**
	 * When true (default), create `.bogstandard/merge-staging` as a detached
	 * git worktree off `main`. Skipped silently if `projectRoot` is not inside
	 * a git work tree. Tests that drive setup against a non-git tmpdir pass
	 * `false` to suppress even the git-detection probe.
	 */
	createStagingWorktree?: boolean;
}

interface GitExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function runGit(args: string[], cwd: string): Promise<GitExecResult> {
	try {
		const res = await execFileP("git", args, { cwd });
		return { stdout: res.stdout, stderr: res.stderr ?? "", code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number };
		if (typeof e.code === "number") {
			return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
		}
		throw err;
	}
}

/** Resolve symlinks if possible; fall back to `resolve()` on failure. macOS
 * tmpdirs and the `git worktree list` output disagree on `/var` vs
 * `/private/var` otherwise. Mirrors `canonicalize` in
 * `scripts/run-merge-worker.ts`.
 */
function canonicalize(path: string): string {
	const abs = resolve(path);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

/**
 * Create `.bogstandard/merge-staging` as a detached worktree off `main` if
 * it's not already registered. Idempotent on repeat runs. Throws with an
 * actionable message if git fails (most commonly: no `main` branch).
 */
export async function ensureStagingWorktree(
	projectRoot: string,
	log: (msg: string) => void,
): Promise<void> {
	const probe = await runGit(["rev-parse", "--is-inside-work-tree"], projectRoot);
	if (probe.code !== 0 || probe.stdout.trim() !== "true") {
		log(`Skipping merge-staging worktree: ${projectRoot} is not a git repository.`);
		return;
	}

	const list = await runGit(["worktree", "list", "--porcelain"], projectRoot);
	if (list.code !== 0) {
		throw new Error(
			`Could not list git worktrees in ${projectRoot}: ${list.stderr.trim() || "git exited non-zero"}`,
		);
	}
	const canonicalRoot = canonicalize(projectRoot);
	const entries = parseWorktreesPorcelain(list.stdout).map((entry) => ({
		...entry,
		path: canonicalize(entry.path),
	}));
	if (isStagingWorktreeRegistered(entries, DEFAULT_MERGE_STAGING_WORKTREE, canonicalRoot)) {
		log(`Merge-staging worktree already present at ${DEFAULT_MERGE_STAGING_WORKTREE}.`);
		return;
	}

	const add = await runGit(
		["worktree", "add", "--detach", DEFAULT_MERGE_STAGING_WORKTREE, "main"],
		projectRoot,
	);
	if (add.code !== 0) {
		throw new Error(
			`Could not create merge-staging worktree at ${DEFAULT_MERGE_STAGING_WORKTREE} ` +
				`(does branch 'main' exist?). git stderr: ${add.stderr.trim() || "(empty)"}`,
		);
	}
	log(`Created merge-staging worktree at ${DEFAULT_MERGE_STAGING_WORKTREE}.`);
}

function defaultMigrationsDir(): string {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	return resolve(scriptDir, "..", "db/migrations");
}

/**
 * Programmatic entry point shared by the CLI (`main`) and the
 * setup-e2e integration test. Creates the DB if missing, applies the
 * full migration chain, and writes the project's `.bogstandard/config.json`.
 */
export async function runSetup(opts: RunSetupOptions): Promise<void> {
	const log = opts.log ?? ((msg: string) => console.log(msg));
	const { adminUrl, dbName } = splitDatabaseUrl(opts.databaseUrl);
	const exists = await databaseExists(adminUrl, dbName);
	if (!exists) {
		await createDatabase(adminUrl, dbName);
	} else {
		log(`Database "${dbName}" already exists; applying schema (idempotent).`);
	}

	const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();
	await applyMigrations(opts.databaseUrl, migrationsDir);

	if (opts.createStagingWorktree ?? true) {
		await ensureStagingWorktree(opts.projectRoot, log);
	}

	writeConfig(
		opts.projectRoot,
		{
			databaseUrl: opts.databaseUrl,
			agentId: opts.agentId,
			staleLockTimeoutMinutes: opts.staleLockTimeoutMinutes,
		},
		opts.force ?? false,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();
	if (args.upgradeConfig) {
		upgradeConfig(projectRoot);
		return;
	}

	const databaseUrl = args.databaseUrl ?? process.env.BOGSTANDARD_DATABASE_URL;
	if (!databaseUrl) {
		printHelp();
		throw new Error("\n--database-url is required (or set BOGSTANDARD_DATABASE_URL).");
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const bogstandardHome = resolve(scriptDir, "..");

	await runSetup({
		databaseUrl,
		projectRoot,
		agentId: args.agentId,
		staleLockTimeoutMinutes: args.staleLockTimeoutMinutes,
		force: args.force,
	});

	console.log(`\nDone. Run from ${projectRoot}:`);
	console.log(`  pi -e ${bogstandardHome}/agent/extensions/bogstandard /bs-design   # brainstorm + create issues`);
	console.log(`  ${bogstandardHome}/bin/bs-run                                       # plan + implement next eligible issue, then merge it`);
	console.log(`\nAdvanced (debugging):`);
	console.log(`  pi -e ${bogstandardHome}/agent/extensions/bogstandard /bs-task     # interactive single worker, no auto-merge`);
}

function reportError(err: unknown): void {
	const e = err as { code?: string; message?: string; stack?: string } | undefined;
	console.error("bs-setup failed:");
	if (e?.code === "ECONNREFUSED") {
		console.error(
			"  Connection refused — is your postgres server running and listening on the host/port in the URL?\n" +
				"  Try: pg_isready -h <host> -p <port>\n" +
				"  macOS quick start: brew services start postgresql  (or use Postgres.app)",
		);
		return;
	}
	if (e?.message && e.message.trim() !== "") {
		console.error(`  ${e.message}`);
		return;
	}
	console.error(e?.stack ?? err);
}

// Run main() only when this file is the entry point — importing the module
// (e.g. from tests) should not execute the CLI flow.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		reportError(err);
		process.exit(1);
	});
}
