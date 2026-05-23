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
 * Apply pending schema migrations to an existing BogStandard postgres
 * database.
 *
 *   npm run migrate -- [--database-url <url>]
 *
 * Reads .bogstandard/config.json for the target connection if --database-url
 * is omitted. Uses node-pg-migrate against db/migrations/, recording applied
 * migrations in the pgmigrations table.
 *
 * Databases created before commit 61b2df3 have no pgmigrations table; the
 * first run here will create it and treat 0001_init as a no-op via
 * CREATE TABLE IF NOT EXISTS, then apply any newer migrations.
 *
 * This does NOT create the database — run bs-setup first for a new project.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../agent/extensions/bogstandard/config.js";
import { applyMigrations } from "./lib/migrations.js";

const { Client } = pg;

interface Args {
	databaseUrl?: string;
}

function parseArgs(argv: string[]): Args {
	const out: Args = {};
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
			case "--help":
			case "-h":
				console.log(
					"Usage: bs-migrate [--database-url <url>]\n" +
						"\nRun from the target project's directory. Applies pending schema\n" +
						"migrations from db/migrations/ against the configured postgres database.",
				);
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}
	return out;
}

async function assertDatabaseExists(url: string): Promise<void> {
	const client = new Client({ connectionString: url });
	try {
		await client.connect();
	} catch (err) {
		const code = (err as { code?: string } | undefined)?.code;
		if (code === "3D000") {
			throw new Error(
				`Database in ${url} does not exist. Run bs-setup first to create it.`,
			);
		}
		throw err;
	} finally {
		await client.end().catch(() => {});
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();
	const cfg = loadConfig({ projectRoot, flagDatabaseUrl: args.databaseUrl });

	console.log(`Target : ${cfg.databaseUrl}`);

	await assertDatabaseExists(cfg.databaseUrl);

	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const bogstandardHome = resolve(scriptDir, "..");
	const migrationsDir = resolve(bogstandardHome, "db/migrations");
	await applyMigrations(cfg.databaseUrl, migrationsDir);

	console.log("\nMigrations up to date.");
}

main().catch((err) => {
	const e = err as { code?: string; message?: string; stack?: string } | undefined;
	console.error("bs-migrate failed:");
	if (e?.code === "ECONNREFUSED") {
		console.error(
			"  Connection refused — is your postgres server running and reachable?\n" +
				"  Try: pg_isready -h <host> -p <port>",
		);
	} else if (e?.message && e.message.trim() !== "") {
		console.error(`  ${e.message}`);
	} else {
		console.error(e?.stack ?? err);
	}
	process.exit(1);
});
