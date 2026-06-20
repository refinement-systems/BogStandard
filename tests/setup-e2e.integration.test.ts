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
 * End-to-end test for `runSetup` — the programmatic core of `bs-setup`.
 *
 * Stage 5 of plan_merge_flow.md asks us to verify that `bs-setup` on a new
 * DB ends up with the bogstandard_merge queue. The per-migration test in
 * migrations-0006.integration.test.ts already covers the migration-runner
 * surface; this test exercises the full create-DB + apply-migrations +
 * write-config composition end-to-end, so a future regression in
 * scripts/setup.ts's wiring (e.g. a stale migrations-dir resolution) gets
 * caught here.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "../scripts/setup.js";
import { parseWorktreesPorcelain } from "../scripts/lib/merge-worker.js";
import { dropDatabase, isPostgresAvailable, randomDbName, urlForDb } from "./helpers/temp-db.js";

const { Client } = pg;
const execFileP = promisify(execFile);

async function initGitRepo(root: string, initialBranch: string): Promise<void> {
	await execFileP("git", ["init", "-b", initialBranch], { cwd: root });
	await execFileP("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test",
		"commit", "--allow-empty", "-m", "init"], { cwd: root });
}

/** Resolve symlinks where possible. macOS tmpdirs are typically `/var/...`
 * symlinks to `/private/var/...`; `git worktree list --porcelain` reports
 * the canonical form. */
function canonical(path: string): string {
	const abs = resolve(path);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

describe.skipIf(!isPostgresAvailable())("runSetup end-to-end", () => {
	let dbName: string;
	let dbUrl: string;
	let projectRoot: string;

	beforeEach(() => {
		dbName = randomDbName();
		dbUrl = urlForDb(dbName);
		projectRoot = mkdtempSync(join(tmpdir(), "bs-setup-e2e-"));
	});

	afterEach(async () => {
		await dropDatabase(dbName);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("creates the database, applies migrations, registers the queue, and writes config.json", async () => {
		await runSetup({
			databaseUrl: dbUrl,
			projectRoot,
			agentId: "stage5-test",
			log: () => {},
			createStagingWorktree: false,
		});

		const client = new Client({ connectionString: dbUrl });
		await client.connect();
		try {
			const mergeTasks = await client.query<{ regclass: string | null }>(
				`SELECT to_regclass('public.merge_tasks')::text AS regclass`,
			);
			expect(mergeTasks.rows[0].regclass).toBe("merge_tasks");

			const mergeSteps = await client.query<{ regclass: string | null }>(
				`SELECT to_regclass('public.merge_task_steps')::text AS regclass`,
			);
			expect(mergeSteps.rows[0].regclass).toBe("merge_task_steps");

			const applied = await client.query<{ name: string }>(
				`SELECT name FROM pgmigrations ORDER BY id`,
			);
			const names = applied.rows.map((r) => r.name);
			expect(names).toContain("0001_init");
			expect(names).toContain("0005_merge_phases");
			expect(names).toContain("0006_merge_queue");
		} finally {
			await client.end();
		}

		const configPath = resolve(projectRoot, ".bogstandard/config.json");
		expect(existsSync(configPath)).toBe(true);
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		expect(config.config_version).toBe(1);
		expect(config.database_url).toBe(dbUrl);
		expect(config.agent_id).toBe("stage5-test");
		expect(config.merge).toEqual({
			test_command: ["npm", "test"],
			test_timeout_seconds: 600,
		});
	}, 60_000);

	it("is idempotent: re-running with force=true keeps one queue row and one applied row per migration", async () => {
		await runSetup({ databaseUrl: dbUrl, projectRoot, log: () => {}, createStagingWorktree: false });

		const countsAfterFirst = await fetchCounts(dbUrl);

		await runSetup({
			databaseUrl: dbUrl,
			projectRoot,
			force: true,
			log: () => {},
			createStagingWorktree: false,
		});

		const countsAfterSecond = await fetchCounts(dbUrl);

		expect(countsAfterSecond.pgmigrations).toBe(countsAfterFirst.pgmigrations);
		expect(countsAfterSecond.mergeTasksTable).toBe(1);
	}, 60_000);
});

describe.skipIf(!isPostgresAvailable())("runSetup merge-staging worktree", () => {
	let dbName: string;
	let dbUrl: string;
	let projectRoot: string;

	beforeEach(() => {
		dbName = randomDbName();
		dbUrl = urlForDb(dbName);
		projectRoot = mkdtempSync(join(tmpdir(), "bs-setup-worktree-"));
	});

	afterEach(async () => {
		await dropDatabase(dbName);
		// Worktrees register absolute paths in the parent repo's index. Since
		// we're tearing down a self-contained repo created in tmpdir, removing
		// the entire projectRoot also destroys the parent — no extra prune
		// needed.
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("creates a detached .bogstandard/merge-staging worktree when run inside a git repo with main", async () => {
		await initGitRepo(projectRoot, "main");

		await runSetup({
			databaseUrl: dbUrl,
			projectRoot,
			log: () => {},
		});

		const stagingPath = resolve(projectRoot, ".bogstandard/merge-staging");
		expect(existsSync(stagingPath)).toBe(true);

		const list = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot });
		const entries = parseWorktreesPorcelain(list.stdout);
		const stagingCanonical = canonical(stagingPath);
		const staging = entries.find((e) => canonical(e.path) === stagingCanonical);
		expect(staging).toBeDefined();
		expect(staging?.detached).toBe(true);
	}, 60_000);

	it("is idempotent: re-running keeps exactly one staging worktree entry", async () => {
		await initGitRepo(projectRoot, "main");

		await runSetup({ databaseUrl: dbUrl, projectRoot, log: () => {} });
		await runSetup({ databaseUrl: dbUrl, projectRoot, force: true, log: () => {} });

		const list = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot });
		const entries = parseWorktreesPorcelain(list.stdout);
		const stagingCanonical = canonical(resolve(projectRoot, ".bogstandard/merge-staging"));
		const matches = entries.filter((e) => canonical(e.path) === stagingCanonical);
		expect(matches).toHaveLength(1);
	}, 60_000);

	it("throws an actionable error when the repo has no `main` branch", async () => {
		await initGitRepo(projectRoot, "trunk");

		await expect(
			runSetup({ databaseUrl: dbUrl, projectRoot, log: () => {} }),
		).rejects.toThrow(/merge-staging worktree.*main/);
	}, 60_000);
});

async function fetchCounts(url: string): Promise<{ pgmigrations: number; mergeTasksTable: number }> {
	const client = new Client({ connectionString: url });
	await client.connect();
	try {
		const m = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM pgmigrations`);
		const t = await client.query<{ regclass: string | null }>(
			`SELECT to_regclass('public.merge_tasks')::text AS regclass`,
		);
		return {
			pgmigrations: Number(m.rows[0].n),
			mergeTasksTable: t.rows[0].regclass === "merge_tasks" ? 1 : 0,
		};
	} finally {
		await client.end();
	}
}
