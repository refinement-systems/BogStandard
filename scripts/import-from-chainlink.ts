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
 * One-shot data importer: copy issues / comments / dependencies / agent
 * config from a chainlink SQLite DB into the BogStandard postgres database.
 *
 *   npm run import -- [--source .chainlink/issues.db] \
 *                     [--agent-json .chainlink/agent.json] \
 *                     [--database-url <url>] \
 *                     [--force]
 *
 * Reads .bogstandard/config.json for the target connection if --database-url
 * is omitted. Refuses to run against a non-empty target unless --force is set.
 * Preserves issue / comment ids and bumps the postgres sequences afterwards
 * so subsequent inserts pick up where the import left off.
 *
 * Not to be confused with bs-migrate (schema migrations).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pg from "pg";
import { loadConfig } from "../agent/extensions/bogstandard/config.js";
import { FIND_CYCLE_SQL } from "../agent/extensions/bogstandard/issue-picker.js";

const { Client } = pg;

interface Args {
	source: string;
	agentJson: string;
	databaseUrl?: string;
	force: boolean;
}

function parseArgs(argv: string[]): Args {
	const out: Args = {
		source: ".chainlink/issues.db",
		agentJson: ".chainlink/agent.json",
		force: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value for ${a}`);
			return v;
		};
		switch (a) {
			case "--source":
				out.source = next();
				break;
			case "--agent-json":
				out.agentJson = next();
				break;
			case "--database-url":
				out.databaseUrl = next();
				break;
			case "--force":
				out.force = true;
				break;
			case "--help":
			case "-h":
				console.log(
					"Usage: bs-import [--source <sqlite-path>] [--agent-json <path>] [--database-url <url>] [--force]\n" +
						"\nRun from the target project's directory. Source paths default to ./.chainlink/issues.db and ./.chainlink/agent.json.",
				);
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}
	return out;
}

interface ChainlinkIssue {
	id: number;
	title: string;
	description: string | null;
	status: string;
	priority: string;
	parent_id: number | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
}

interface ChainlinkComment {
	id: number;
	issue_id: number;
	content: string;
	created_at: string;
	kind: string | null;
}

interface ChainlinkDep {
	blocker_id: number;
	blocked_id: number;
}

async function assertTargetEmpty(client: pg.Client, force: boolean): Promise<void> {
	const tables = ["issues", "comments", "dependencies"];
	for (const t of tables) {
		const res = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${t}`);
		const count = Number(res.rows[0]?.count ?? 0);
		if (count > 0 && !force) {
			throw new Error(
				`Target table "${t}" already contains ${count} rows. Refusing to migrate without --force.`,
			);
		}
	}
}

function chainlinkStatusToPhase(s: string): string {
	switch (s) {
		case "open":     return "ready";
		case "draft":    return "drafting";
		case "closed":   return "done";
		case "archived": return "archived";
		default:         return "ready";
	}
}

async function migrateIssues(
	client: pg.Client,
	rows: ChainlinkIssue[],
): Promise<Map<number, number>> {
	const issueIdToVersionId = new Map<number, number>();
	if (rows.length === 0) return issueIdToVersionId;
	for (const r of rows) {
		await client.query(
			`INSERT INTO issues (id, phase, priority, created_at, updated_at, closed_at)
			      VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				r.id,
				chainlinkStatusToPhase(r.status),
				r.priority,
				r.created_at,
				r.updated_at,
				r.closed_at,
			],
		);
		const versionRes = await client.query<{ id: string }>(
			`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests, created_at)
			      VALUES ($1, 1, $2, $3, NULL, $4)
			   RETURNING id`,
			[r.id, r.title, r.description, r.created_at],
		);
		const versionId = Number(versionRes.rows[0].id);
		issueIdToVersionId.set(r.id, versionId);
		await client.query(
			`UPDATE issues SET current_version_id = $1 WHERE id = $2`,
			[versionId, r.id],
		);
	}
	// Convert chainlink parent_id into equivalent block edges (child blocks parent),
	// matching the picker's prior semantics. Idempotent against any block edges
	// that already exist in the source dependencies table.
	let convertedParents = 0;
	for (const r of rows) {
		if (r.parent_id !== null && r.parent_id !== undefined) {
			const res = await client.query(
				`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[r.id, r.parent_id],
			);
			convertedParents += res.rowCount ?? 0;
		}
	}
	await client.query(
		`SELECT setval('issues_id_seq', (SELECT COALESCE(MAX(id), 1) FROM issues))`,
	);
	console.log(`  issues       : ${rows.length}`);
	console.log(`  versions     : ${issueIdToVersionId.size}`);
	if (convertedParents > 0) {
		console.log(`  parent→block : ${convertedParents}`);
	}
	return issueIdToVersionId;
}

async function migrateComments(
	client: pg.Client,
	rows: ChainlinkComment[],
	issueIdToVersionId: Map<number, number>,
): Promise<void> {
	for (const r of rows) {
		const versionId = issueIdToVersionId.get(r.issue_id);
		if (versionId === undefined) {
			console.warn(`  comment #${r.id} skipped: issue #${r.issue_id} not imported`);
			continue;
		}
		await client.query(
			`INSERT INTO comments (id, issue_id, version_id, kind, content, created_at)
			      VALUES ($1, $2, $3, $4, $5, $6)`,
			[r.id, r.issue_id, versionId, r.kind ?? "note", r.content, r.created_at],
		);
	}
	if (rows.length > 0) {
		await client.query(
			`SELECT setval('comments_id_seq', (SELECT COALESCE(MAX(id), 1) FROM comments))`,
		);
	}
	console.log(`  comments     : ${rows.length}`);
}

async function migrateDeps(client: pg.Client, rows: ChainlinkDep[]): Promise<void> {
	for (const r of rows) {
		await client.query(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			[r.blocker_id, r.blocked_id],
		);
	}
	console.log(`  dependencies : ${rows.length}`);
}

/**
 * Run cycle detection against the imported block graph. The migration script
 * makes the same check; we repeat it here because the importer bypasses
 * `dependencyAdd`'s per-edge guard and writes both the chainlink dependency
 * rows and any converted parent_id edges directly.
 */
async function assertNoCycles(client: pg.Client): Promise<void> {
	const res = await client.query<{ path: Array<string | number> | null }>(FIND_CYCLE_SQL);
	const path = res.rows[0]?.path;
	if (path && path.length > 0) {
		const formatted = path.map((v) => `#${v}`).join(" → ");
		throw new Error(
			`Imported block graph contains a cycle: ${formatted}. Rolled back; fix the source data and retry.`,
		);
	}
}

async function migrateAgentJson(client: pg.Client, agentJsonPath: string): Promise<void> {
	if (!existsSync(agentJsonPath)) {
		console.log(`  agent_config : (no ${agentJsonPath} found, skipping)`);
		return;
	}
	let parsed: { agent_id?: string; description?: string };
	try {
		parsed = JSON.parse(readFileSync(agentJsonPath, "utf8"));
	} catch (err) {
		console.warn(`  agent_config : ${agentJsonPath} could not be parsed (${(err as Error).message}); skipping`);
		return;
	}
	if (!parsed.agent_id) {
		console.log(`  agent_config : ${agentJsonPath} has no agent_id; skipping`);
		return;
	}
	await client.query(
		`INSERT INTO agent_config (id, agent_id, description) VALUES (1, $1, $2)
		 ON CONFLICT (id) DO UPDATE SET agent_id = EXCLUDED.agent_id, description = EXCLUDED.description`,
		[parsed.agent_id, parsed.description ?? null],
	);
	console.log(`  agent_config : agent_id="${parsed.agent_id}"`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();

	const cfg = loadConfig({
		projectRoot,
		flagDatabaseUrl: args.databaseUrl,
	});

	const sourcePath = resolve(projectRoot, args.source);
	if (!existsSync(sourcePath)) {
		throw new Error(`Source SQLite database not found: ${sourcePath}`);
	}
	console.log(`Source : ${sourcePath}`);
	console.log(`Target : ${cfg.databaseUrl}`);

	const sqlite = new Database(sourcePath, { readonly: true });
	const issues = sqlite
		.prepare(
			`SELECT id, title, description, status, priority, parent_id, created_at, updated_at, closed_at
			   FROM issues ORDER BY id`,
		)
		.all() as ChainlinkIssue[];
	const comments = sqlite
		.prepare(
			`SELECT id, issue_id, content, created_at, kind FROM comments ORDER BY id`,
		)
		.all() as ChainlinkComment[];
	const deps = sqlite
		.prepare(`SELECT blocker_id, blocked_id FROM dependencies`)
		.all() as ChainlinkDep[];
	sqlite.close();

	const client = new Client({ connectionString: cfg.databaseUrl });
	await client.connect();
	try {
		await assertTargetEmpty(client, args.force);
		await client.query("BEGIN");
		try {
			const issueIdToVersionId = await migrateIssues(client, issues);
			await migrateComments(client, comments, issueIdToVersionId);
			await migrateDeps(client, deps);
			await migrateAgentJson(client, resolve(projectRoot, args.agentJson));
			await assertNoCycles(client);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		await client.end();
	}

	console.log("\nImport complete.");
}

main().catch((err) => {
	const e = err as { code?: string; message?: string; stack?: string } | undefined;
	console.error("bs-import failed:");
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
