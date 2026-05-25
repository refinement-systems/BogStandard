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
 * Per-file temporary postgres database for integration tests.
 *
 * Each test file that imports `useTempDb` gets its own database (a random
 * `bs_test_<hex>` name on the admin server pointed to by `BS_TEST_ADMIN_URL`,
 * default `postgres://localhost:5432/postgres`). The full migration set is
 * applied via the same `applyMigrations` runner production setup uses, so the
 * schema-under-test matches the schema-in-prod.
 *
 * `beforeAll` creates + migrates the DB and calls `configureDb` so the
 * module-level pool in `db.ts` is wired up for this file's lifetime.
 * `afterAll` ends the pool (`resetDbForTests`) and drops the database.
 *
 * When the admin server is unreachable the probe sets POSTGRES_AVAILABLE to
 * false and a single warning is printed. Integration `describe` blocks opt in
 * with `describe.skipIf(!isPostgresAvailable())` so unit tests stay green on
 * machines without a local postgres.
 *
 * `useTempDbThrough(throughFile)` is the partial-application variant: it
 * applies migrations only up to and including `throughFile` (e.g.
 * "0002_draft_status.sql"). Tests then populate pre-migration data and call
 * `handle.applyRemaining()` to bring the DB to head. Used to exercise
 * migration backfills against realistic legacy data.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { configureDb, resetDbForTests } from "../../agent/extensions/bogstandard/db.js";
import { applyMigrations } from "../../scripts/lib/migrations.js";

const { Client } = pg;

const ADMIN_URL = process.env.BS_TEST_ADMIN_URL ?? "postgres://localhost:5432/postgres";

const MIGRATIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../db/migrations",
);

async function probeAdmin(): Promise<boolean> {
	const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000 });
	try {
		await client.connect();
		await client.end();
		return true;
	} catch {
		return false;
	}
}

const POSTGRES_AVAILABLE = await probeAdmin();

if (!POSTGRES_AVAILABLE) {
	console.warn(
		`[temp-db] integration tests skipped: cannot reach ${ADMIN_URL}. ` +
			`Start postgres or set BS_TEST_ADMIN_URL to a reachable admin DB.`,
	);
}

export function isPostgresAvailable(): boolean {
	return POSTGRES_AVAILABLE;
}

/** Admin URL exposed for tests that need to create siblings of the temp DB. */
export function getAdminUrl(): string {
	return ADMIN_URL;
}

/** Migrations directory exposed for tests that need to inspect or re-apply migrations directly. */
export function getMigrationsDir(): string {
	return MIGRATIONS_DIR;
}

/** Make a random `bs_test_<hex>` database name. */
export function randomDbName(): string {
	return `bs_test_${randomBytes(4).toString("hex")}`;
}

/** Replace the database segment of `ADMIN_URL` with `dbName`. */
export function urlForDb(dbName: string): string {
	const u = new URL(ADMIN_URL);
	u.pathname = `/${dbName}`;
	return u.toString();
}

/** Create a database on ADMIN_URL. */
export async function createDatabase(dbName: string): Promise<void> {
	const admin = new Client({ connectionString: ADMIN_URL });
	await admin.connect();
	try {
		await admin.query(`CREATE DATABASE "${dbName}"`);
	} finally {
		await admin.end();
	}
}

/** Drop a database on ADMIN_URL. */
export async function dropDatabase(dbName: string): Promise<void> {
	const admin = new Client({ connectionString: ADMIN_URL });
	await admin.connect();
	try {
		await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
	} finally {
		await admin.end();
	}
}

/**
 * Apply migrations from MIGRATIONS_DIR only up to and including `throughFile`
 * (e.g. "0002_draft_status.sql"). Achieved by copying the subset into a temp
 * dir and pointing the production runner at it. Throws if `throughFile`
 * doesn't exist in the migrations directory.
 */
export async function applyMigrationsThrough(url: string, throughFile: string): Promise<void> {
	const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
	if (!all.includes(throughFile)) {
		throw new Error(`applyMigrationsThrough: ${throughFile} not in ${MIGRATIONS_DIR}`);
	}
	const subset = all.slice(0, all.indexOf(throughFile) + 1);
	const tmp = mkdtempSync(join(tmpdir(), "bs-migrations-"));
	try {
		for (const f of subset) {
			copyFileSync(join(MIGRATIONS_DIR, f), join(tmp, f));
		}
		await applyMigrations(url, tmp);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Apply migrations from a custom directory containing arbitrary SQL files.
 * Used by setup/migrate tests that need to simulate a pre-`61b2df3` database
 * shape (raw 0001 SQL applied directly without pgmigrations bookkeeping).
 */
export async function applyMigrationsFromDir(url: string, dir: string): Promise<void> {
	await applyMigrations(url, dir);
}

export interface TempDbHandle {
	/** The temp database's connection URL. Throws if accessed before beforeAll completes. */
	url: () => string;
	/** The agent id passed to `configureDb`. */
	agentId: string;
}

/**
 * Register beforeAll/afterAll hooks that create + drop a per-file temp
 * database. Returns a handle so tests can read the URL if they need to
 * connect outside the configured pool (rare; most should use `getPool()`).
 */
export function useTempDb(opts: { agentId?: string } = {}): TempDbHandle {
	const agentId = opts.agentId ?? "test";
	let dbName: string | undefined;
	let dbUrl: string | undefined;

	beforeAll(async () => {
		if (!POSTGRES_AVAILABLE) return;
		dbName = randomDbName();
		dbUrl = urlForDb(dbName);

		await createDatabase(dbName);
		await applyMigrations(dbUrl, MIGRATIONS_DIR);

		configureDb({ databaseUrl: dbUrl, agentId, staleLockTimeoutMinutes: 60 });
	}, 30_000);

	afterAll(async () => {
		if (!POSTGRES_AVAILABLE || !dbName) return;
		await resetDbForTests();
		await dropDatabase(dbName);
	}, 30_000);

	return {
		url: () => {
			if (!dbUrl) throw new Error("useTempDb: url() called before beforeAll completed");
			return dbUrl;
		},
		agentId,
	};
}

export interface TempDbThroughHandle extends TempDbHandle {
	/** Apply the remaining migrations after `throughFile`. Tests call this after seeding pre-migration data. */
	applyRemaining: () => Promise<void>;
	/** Apply migrations up to a specific further file (between `throughFile` and head). Useful for stepping through migrations one at a time. */
	applyThrough: (file: string) => Promise<void>;
	/**
	 * Configure the global db.ts pool against this DB. Tests that only use
	 * raw `pg.Client` (e.g. migration assertion tests) can skip this; tests
	 * that want to call db.ts functions should invoke it after the schema
	 * reaches head.
	 */
	configurePool: () => void;
}

/**
 * Partial-application variant of `useTempDb`. Applies migrations only up to
 * (and including) `throughFile`. Tests then populate pre-migration data via
 * raw pg.Client and call `handle.applyRemaining()` to bring the DB to head.
 *
 * Does NOT call `configureDb` automatically — migration tests usually want
 * to inspect with raw queries, and applying `configureDb` against a
 * partial-schema DB would invite confusion. Call `handle.configurePool()`
 * explicitly after `applyRemaining()` if you need the db.ts functions.
 */
export function useTempDbThrough(throughFile: string, opts: { agentId?: string } = {}): TempDbThroughHandle {
	const agentId = opts.agentId ?? "test";
	let dbName: string | undefined;
	let dbUrl: string | undefined;

	beforeAll(async () => {
		if (!POSTGRES_AVAILABLE) return;
		dbName = randomDbName();
		dbUrl = urlForDb(dbName);

		await createDatabase(dbName);
		await applyMigrationsThrough(dbUrl, throughFile);
	}, 30_000);

	afterAll(async () => {
		if (!POSTGRES_AVAILABLE || !dbName) return;
		await resetDbForTests();
		await dropDatabase(dbName);
	}, 30_000);

	return {
		url: () => {
			if (!dbUrl) throw new Error("useTempDbThrough: url() called before beforeAll completed");
			return dbUrl;
		},
		agentId,
		applyRemaining: async () => {
			if (!dbUrl) throw new Error("useTempDbThrough: applyRemaining called before beforeAll completed");
			await applyMigrations(dbUrl, MIGRATIONS_DIR);
		},
		applyThrough: async (file: string) => {
			if (!dbUrl) throw new Error("useTempDbThrough: applyThrough called before beforeAll completed");
			await applyMigrationsThrough(dbUrl, file);
		},
		configurePool: () => {
			if (!dbUrl) throw new Error("useTempDbThrough: configurePool called before beforeAll completed");
			configureDb({ databaseUrl: dbUrl, agentId, staleLockTimeoutMinutes: 60 });
		},
	};
}

/**
 * Identical to useTempDb but skips migrations entirely. Used by tests that
 * want to apply migrations themselves (e.g. setup/migrate scripts that must
 * see the bootstrap path where pgmigrations doesn't yet exist).
 */
export function useEmptyTempDb(): { url: () => string; dbName: () => string } {
	let dbName: string | undefined;
	let dbUrl: string | undefined;

	beforeAll(async () => {
		if (!POSTGRES_AVAILABLE) return;
		dbName = randomDbName();
		dbUrl = urlForDb(dbName);
		await createDatabase(dbName);
	}, 30_000);

	afterAll(async () => {
		if (!POSTGRES_AVAILABLE || !dbName) return;
		await resetDbForTests();
		await dropDatabase(dbName);
	}, 30_000);

	return {
		url: () => {
			if (!dbUrl) throw new Error("useEmptyTempDb: url() called before beforeAll completed");
			return dbUrl;
		},
		dbName: () => {
			if (!dbName) throw new Error("useEmptyTempDb: dbName() called before beforeAll completed");
			return dbName;
		},
	};
}

/** Write SQL text to a temp file and return its absolute path. */
export function writeTempSqlFile(filename: string, sql: string): string {
	const tmp = mkdtempSync(join(tmpdir(), "bs-sql-"));
	const path = join(tmp, filename);
	writeFileSync(path, sql);
	return path;
}
