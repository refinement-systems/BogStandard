#!/usr/bin/env tsx
/**
 * BogStandard one-time setup.
 *
 *   npm run setup -- --database-url postgres://localhost:5432/bogstandard_myproject \
 *                    [--agent-id main] \
 *                    [--stale-lock-timeout-minutes 60] \
 *                    [--force]
 *
 * What it does:
 *   1. Connects to the target database (creating it via the postgres admin DB
 *      if it doesn't exist).
 *   2. Runs db/migrations/0001_init.sql.
 *   3. Writes .bogstandard/config.json with the URL + agent id.
 *
 * Idempotent w.r.t. the schema (`CREATE TABLE IF NOT EXISTS`). Refuses to
 * overwrite an existing config.json unless --force is passed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

interface Args {
	databaseUrl?: string;
	agentId?: string;
	staleLockTimeoutMinutes?: number;
	force: boolean;
}

function parseArgs(argv: string[]): Args {
	const out: Args = { force: false };
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
			`\n` +
			`Run from the target project's directory. Writes .bogstandard/config.json there.\n` +
			`Defaults: agent-id=main, stale-lock-timeout-minutes=60.\n` +
			`The database is created automatically (via the postgres admin DB) if missing.`,
	);
}

/** Split a postgres URL into (adminUrl, dbName). */
function splitDatabaseUrl(url: string): { adminUrl: string; dbName: string } {
	const u = new URL(url);
	const dbName = u.pathname.replace(/^\//, "");
	if (!dbName) {
		throw new Error(`Database URL ${url} has no database name in its path`);
	}
	u.pathname = "/postgres";
	return { adminUrl: u.toString(), dbName };
}

async function databaseExists(adminUrl: string, dbName: string): Promise<boolean> {
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

async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
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

async function applySchema(url: string, schemaSql: string): Promise<void> {
	const client = new Client({ connectionString: url });
	await client.connect();
	try {
		await client.query(schemaSql);
		console.log("Applied schema (db/migrations/0001_init.sql).");
	} finally {
		await client.end();
	}
}

function writeConfig(
	projectRoot: string,
	args: Required<Pick<Args, "databaseUrl">> & Pick<Args, "agentId" | "staleLockTimeoutMinutes">,
	force: boolean,
): string {
	const dir = resolve(projectRoot, ".bogstandard");
	const path = resolve(dir, "config.json");
	if (existsSync(path) && !force) {
		throw new Error(
			`${path} already exists. Re-run with --force to overwrite, or edit it by hand.`,
		);
	}
	mkdirSync(dir, { recursive: true });
	const body = {
		database_url: args.databaseUrl,
		agent_id: args.agentId ?? "main",
		stale_lock_timeout_minutes: args.staleLockTimeoutMinutes ?? 60,
	};
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
	console.log(`Wrote ${path}.`);
	return path;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const databaseUrl = args.databaseUrl ?? process.env.BOGSTANDARD_DATABASE_URL;
	if (!databaseUrl) {
		printHelp();
		throw new Error("\n--database-url is required (or set BOGSTANDARD_DATABASE_URL).");
	}

	const { adminUrl, dbName } = splitDatabaseUrl(databaseUrl);
	const exists = await databaseExists(adminUrl, dbName);
	if (!exists) {
		await createDatabase(adminUrl, dbName);
	} else {
		console.log(`Database "${dbName}" already exists; applying schema (idempotent).`);
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const bogstandardHome = resolve(scriptDir, "..");
	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();
	const schemaPath = resolve(bogstandardHome, "db/migrations/0001_init.sql");
	const schemaSql = readFileSync(schemaPath, "utf8");
	await applySchema(databaseUrl, schemaSql);

	writeConfig(projectRoot, { databaseUrl, agentId: args.agentId, staleLockTimeoutMinutes: args.staleLockTimeoutMinutes }, args.force);

	console.log(`\nDone. Run pi from ${projectRoot} with:`);
	console.log(`  pi -e ${bogstandardHome}/agent/extensions/bogstandard /bs-design   # brainstorm + create issues`);
	console.log(`  pi -e ${bogstandardHome}/agent/extensions/bogstandard /bs-task     # plan + implement next eligible issue`);
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

main().catch((err) => {
	reportError(err);
	process.exit(1);
});
