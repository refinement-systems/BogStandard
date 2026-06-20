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
 * Tests for `scripts/setup.ts` helpers.
 *
 * Pure helpers (splitDatabaseUrl, writeConfig) run as plain unit tests.
 * DB-touching helpers (databaseExists, createDatabase) use the live admin URL
 * the integration suite already requires.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, databaseExists, splitDatabaseUrl, writeConfig } from "../scripts/setup.js";
import { dropDatabase, getAdminUrl, isPostgresAvailable, randomDbName } from "./helpers/temp-db.js";

describe("splitDatabaseUrl", () => {
	it("splits a typical URL into adminUrl + dbName", () => {
		const { adminUrl, dbName } = splitDatabaseUrl("postgres://localhost:5432/bogstandard_test");
		expect(dbName).toBe("bogstandard_test");
		expect(adminUrl).toBe("postgres://localhost:5432/postgres");
	});

	it("preserves port and host", () => {
		const { adminUrl, dbName } = splitDatabaseUrl("postgres://example.com:6543/my_db");
		expect(dbName).toBe("my_db");
		expect(adminUrl).toBe("postgres://example.com:6543/postgres");
	});

	it("strips the original db name and replaces with 'postgres'", () => {
		const { adminUrl } = splitDatabaseUrl("postgres://localhost/some_db");
		expect(adminUrl).toBe("postgres://localhost/postgres");
	});

	it("preserves credentials when present", () => {
		const { adminUrl, dbName } = splitDatabaseUrl("postgres://u:p@host:5432/mydb");
		expect(dbName).toBe("mydb");
		expect(adminUrl).toBe("postgres://u:p@host:5432/postgres");
	});

	it("throws when the URL has no database name in its path", () => {
		expect(() => splitDatabaseUrl("postgres://localhost:5432/")).toThrow(/no database name/);
	});
});

describe("writeConfig", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "bs-setup-"));
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("writes a valid .bogstandard/config.json under the project root", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		const path = writeConfig(
			projectRoot,
			{ databaseUrl: "postgres://localhost/foo", agentId: "alpha", staleLockTimeoutMinutes: 30 },
			false,
		);
		expect(path).toBe(resolve(projectRoot, ".bogstandard/config.json"));
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		expect(parsed).toEqual({
			config_version: 1,
			database_url: "postgres://localhost/foo",
			agent_id: "alpha",
			stale_lock_timeout_minutes: 30,
			merge: {
				test_command: ["npm", "test"],
				test_timeout_seconds: 600,
			},
		});
	});

	it("applies defaults agent_id=main, stale_lock_timeout_minutes=60", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		const path = writeConfig(projectRoot, { databaseUrl: "postgres://localhost/foo" }, false);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		expect(parsed.config_version).toBe(1);
		expect(parsed.agent_id).toBe("main");
		expect(parsed.stale_lock_timeout_minutes).toBe(60);
	});

	it("seeds the merge block with a placeholder test_command and default timeout", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		const path = writeConfig(projectRoot, { databaseUrl: "postgres://localhost/foo" }, false);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		expect(parsed.merge).toEqual({
			test_command: ["npm", "test"],
			test_timeout_seconds: 600,
		});
	});

	it("refuses to overwrite an existing config without force", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		writeConfig(projectRoot, { databaseUrl: "postgres://localhost/foo" }, false);
		expect(() => writeConfig(projectRoot, { databaseUrl: "postgres://localhost/bar" }, false)).toThrow(
			/already exists/,
		);
	});

	it("overwrites with force", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		writeConfig(projectRoot, { databaseUrl: "postgres://localhost/foo" }, false);
		writeConfig(projectRoot, { databaseUrl: "postgres://localhost/bar" }, true);
		const parsed = JSON.parse(
			readFileSync(resolve(projectRoot, ".bogstandard/config.json"), "utf8"),
		);
		expect(parsed.database_url).toBe("postgres://localhost/bar");
	});

	it("creates the .bogstandard directory if it doesn't exist", () => {
		const projectRoot = mkdtempSync(join(tmp, "p-"));
		expect(existsSync(resolve(projectRoot, ".bogstandard"))).toBe(false);
		writeConfig(projectRoot, { databaseUrl: "postgres://localhost/foo" }, false);
		expect(existsSync(resolve(projectRoot, ".bogstandard"))).toBe(true);
	});
});

describe.skipIf(!isPostgresAvailable())("databaseExists / createDatabase", () => {
	const adminUrl = getAdminUrl();

	it("databaseExists returns false for a never-created name", async () => {
		expect(await databaseExists(adminUrl, "bs_never_made_" + randomDbName())).toBe(false);
	});

	it("databaseExists returns true after CREATE; false after DROP", async () => {
		const name = randomDbName();
		try {
			await createDatabase(adminUrl, name);
			expect(await databaseExists(adminUrl, name)).toBe(true);
		} finally {
			await dropDatabase(name);
		}
		expect(await databaseExists(adminUrl, name)).toBe(false);
	});

	it.each([
		`'; DROP TABLE issues; --`,
		`with-hyphen`,
		`1starts_with_digit`,
		`has space`,
		`semi;colon`,
	])("createDatabase rejects unsafe name '%s'", async (name) => {
		await expect(createDatabase(adminUrl, name)).rejects.toThrow(/Refusing to CREATE DATABASE/);
	});

	it("createDatabase accepts a safe identifier and then can be dropped", async () => {
		const name = randomDbName(); // matches the safe identifier regex
		try {
			await createDatabase(adminUrl, name);
			expect(await databaseExists(adminUrl, name)).toBe(true);
		} finally {
			await dropDatabase(name);
		}
	});
});
