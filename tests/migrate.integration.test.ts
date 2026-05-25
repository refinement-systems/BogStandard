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
 * Tests for `scripts/migrate.ts` (and the underlying scripts/lib/migrations.ts
 * runner). The bootstrap test exercises the path advertised in AGENTS.md:
 * a pre-`61b2df3` DB has no `pgmigrations` table — the first run of
 * applyMigrations creates it, treats 0001 as a no-op (CREATE TABLE IF NOT
 * EXISTS), and applies the rest.
 */

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDatabaseExists } from "../scripts/migrate.js";
import { applyMigrations } from "../scripts/lib/migrations.js";
import {
	createDatabase,
	dropDatabase,
	isPostgresAvailable,
	randomDbName,
	urlForDb,
} from "./helpers/temp-db.js";

const { Client } = pg;

const MIGRATIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../db/migrations",
);

describe.skipIf(!isPostgresAvailable())("assertDatabaseExists", () => {
	it("succeeds when the database exists", async () => {
		const name = randomDbName();
		await createDatabase(name);
		try {
			await expect(assertDatabaseExists(urlForDb(name))).resolves.toBeUndefined();
		} finally {
			await dropDatabase(name);
		}
	});

	it("throws a friendly error when the database does not exist (3D000)", async () => {
		const name = randomDbName();
		await expect(assertDatabaseExists(urlForDb(name))).rejects.toThrow(/does not exist/);
	});
});

describe.skipIf(!isPostgresAvailable())("applyMigrations bootstrap path", () => {
	let name: string;
	let url: string;

	beforeEach(async () => {
		name = randomDbName();
		url = urlForDb(name);
		await createDatabase(name);
	});

	afterEach(async () => {
		await dropDatabase(name);
	});

	it("creates pgmigrations on a fresh DB and applies all migrations from scratch", async () => {
		await applyMigrations(url, MIGRATIONS_DIR);

		const c = new Client({ connectionString: url });
		await c.connect();
		try {
			const pgm = await c.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY id`);
			const names = pgm.rows.map((r) => r.name);
			expect(names).toContain("0001_init");
			expect(names).toContain("0002_draft_status");
			expect(names).toContain("0003_phase_state_and_versioning");
			expect(names).toContain("0004_drop_parent_id");
		} finally {
			await c.end();
		}
	});

	it("bootstraps on a pre-pgmigrations DB: 0001's CREATE TABLE IF NOT EXISTS is idempotent", async () => {
		// Simulate a pre-`61b2df3` DB: apply 0001's raw SQL outside the pgmigrations
		// machinery (so the bookkeeping row does not exist), then run applyMigrations
		// and assert it (a) creates pgmigrations, (b) records 0001 as applied, and
		// (c) walks 0002-0004 forward without error.
		const init = readFileSync(join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
		const c = new Client({ connectionString: url });
		await c.connect();
		try {
			await c.query(init);
		} finally {
			await c.end();
		}

		// Sanity: pgmigrations does not exist.
		const pre = new Client({ connectionString: url });
		await pre.connect();
		try {
			const exists = await pre.query<{ exists: boolean }>(
				`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pgmigrations') AS exists`,
			);
			expect(exists.rows[0].exists).toBe(false);
		} finally {
			await pre.end();
		}

		// Run applyMigrations. Should not throw.
		await applyMigrations(url, MIGRATIONS_DIR);

		// Now pgmigrations exists and 0001 is recorded.
		const post = new Client({ connectionString: url });
		await post.connect();
		try {
			const pgm = await post.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY id`);
			const names = pgm.rows.map((r) => r.name);
			expect(names).toContain("0001_init");
			expect(names).toContain("0004_drop_parent_id");
			// Phase column exists from 0003, so 0003 ran successfully.
			const col = await post.query<{ column_name: string }>(
				`SELECT column_name FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'phase'`,
			);
			expect(col.rowCount).toBe(1);
		} finally {
			await post.end();
		}
	});

	it("is idempotent: running applyMigrations twice does not re-apply anything", async () => {
		await applyMigrations(url, MIGRATIONS_DIR);
		const firstRun = await fetchPgmigrationsCount(url);
		await applyMigrations(url, MIGRATIONS_DIR);
		const secondRun = await fetchPgmigrationsCount(url);
		expect(secondRun).toBe(firstRun);
	});

	it("applies only the new migrations when a custom migrations dir adds one", async () => {
		// Apply the full set first.
		await applyMigrations(url, MIGRATIONS_DIR);

		// Stage a new migration file in a temp dir alongside copies of the existing ones.
		const stage = mkdtempSync(join(tmpdir(), "bs-mig-extra-"));
		try {
			for (const f of ["0001_init.sql", "0002_draft_status.sql", "0003_phase_state_and_versioning.sql", "0004_drop_parent_id.sql"]) {
				writeFileSync(join(stage, f), readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
			}
			writeFileSync(
				join(stage, "0099_test_extra.sql"),
				`CREATE TABLE IF NOT EXISTS test_extra (id INT PRIMARY KEY);`,
			);
			await applyMigrations(url, stage);

			const c = new Client({ connectionString: url });
			await c.connect();
			try {
				const pgm = await c.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY id`);
				expect(pgm.rows.map((r) => r.name)).toContain("0099_test_extra");
				const t = await c.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'test_extra'`,
				);
				expect(Number(t.rows[0].count)).toBe(1);
			} finally {
				await c.end();
			}
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});
});

async function fetchPgmigrationsCount(url: string): Promise<number> {
	const c = new Client({ connectionString: url });
	await c.connect();
	try {
		const res = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pgmigrations`);
		return Number(res.rows[0].n);
	} finally {
		await c.end();
	}
}
