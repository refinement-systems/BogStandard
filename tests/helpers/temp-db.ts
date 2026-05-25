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
 */

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { configureDb, resetDbForTests } from "../../agent/extensions/bogstandard/db.js";
import { applyMigrations } from "../../scripts/lib/migrations.js";

const { Client } = pg;

const ADMIN_URL = process.env.BS_TEST_ADMIN_URL ?? "postgres://localhost:5432/postgres";

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
		dbName = `bs_test_${randomBytes(4).toString("hex")}`;
		const u = new URL(ADMIN_URL);
		u.pathname = `/${dbName}`;
		dbUrl = u.toString();

		const admin = new Client({ connectionString: ADMIN_URL });
		await admin.connect();
		try {
			await admin.query(`CREATE DATABASE "${dbName}"`);
		} finally {
			await admin.end();
		}

		const migrationsDir = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../db/migrations",
		);
		await applyMigrations(dbUrl, migrationsDir);

		configureDb({ databaseUrl: dbUrl, agentId, staleLockTimeoutMinutes: 60 });
	}, 30_000);

	afterAll(async () => {
		if (!POSTGRES_AVAILABLE || !dbName) return;
		await resetDbForTests();

		const admin = new Client({ connectionString: ADMIN_URL });
		await admin.connect();
		try {
			await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
		} finally {
			await admin.end();
		}
	}, 30_000);

	return {
		url: () => {
			if (!dbUrl) throw new Error("useTempDb: url() called before beforeAll completed");
			return dbUrl;
		},
		agentId,
	};
}
