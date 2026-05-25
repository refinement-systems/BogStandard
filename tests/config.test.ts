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

import { describe, expect, it } from "vitest";
import {
	DEFAULT_AGENT_ID,
	DEFAULT_MERGE_STAGING_WORKTREE,
	DEFAULT_MERGE_TEST_TIMEOUT_SECONDS,
	DEFAULT_STALE_LOCK_TIMEOUT_MINUTES,
	resolveConfig,
} from "../agent/extensions/bogstandard/config.js";

describe("resolveConfig precedence", () => {
	it("uses the flag database URL when all three sources are set", () => {
		const result = resolveConfig({
			flagDatabaseUrl: "postgres://flag/db",
			env: { BOGSTANDARD_DATABASE_URL: "postgres://env/db" },
			file: { database_url: "postgres://file/db" },
		});
		expect(result.databaseUrl).toBe("postgres://flag/db");
	});

	it("falls back to env when no flag is set", () => {
		const result = resolveConfig({
			env: { BOGSTANDARD_DATABASE_URL: "postgres://env/db" },
			file: { database_url: "postgres://file/db" },
		});
		expect(result.databaseUrl).toBe("postgres://env/db");
	});

	it("falls back to file when neither flag nor env is set", () => {
		const result = resolveConfig({ file: { database_url: "postgres://file/db" } });
		expect(result.databaseUrl).toBe("postgres://file/db");
	});

	it("throws when no database URL is reachable", () => {
		expect(() => resolveConfig({})).toThrow(/No postgres connection configured/);
	});

	it("throws when the database URL is an empty string", () => {
		expect(() => resolveConfig({ flagDatabaseUrl: "   " })).toThrow(/No postgres connection/);
	});

	it("applies the same precedence to agent_id", () => {
		expect(
			resolveConfig({
				flagDatabaseUrl: "postgres://x",
				flagAgentId: "flag-agent",
				env: { BOGSTANDARD_AGENT_ID: "env-agent" },
				file: { agent_id: "file-agent" },
			}).agentId,
		).toBe("flag-agent");
		expect(
			resolveConfig({
				flagDatabaseUrl: "postgres://x",
				env: { BOGSTANDARD_AGENT_ID: "env-agent" },
				file: { agent_id: "file-agent" },
			}).agentId,
		).toBe("env-agent");
		expect(
			resolveConfig({
				flagDatabaseUrl: "postgres://x",
				file: { agent_id: "file-agent" },
			}).agentId,
		).toBe("file-agent");
	});

	it("falls back to DEFAULT_AGENT_ID when nothing supplies an agent id", () => {
		expect(resolveConfig({ flagDatabaseUrl: "postgres://x" }).agentId).toBe(DEFAULT_AGENT_ID);
	});

	it("takes stale_lock_timeout_minutes only from the file", () => {
		expect(
			resolveConfig({
				flagDatabaseUrl: "postgres://x",
				file: { stale_lock_timeout_minutes: 15 },
			}).staleLockTimeoutMinutes,
		).toBe(15);
		expect(
			resolveConfig({ flagDatabaseUrl: "postgres://x" }).staleLockTimeoutMinutes,
		).toBe(DEFAULT_STALE_LOCK_TIMEOUT_MINUTES);
	});
});

describe("resolveConfig merge block", () => {
	it("leaves merge undefined when the file omits the block", () => {
		expect(
			resolveConfig({ flagDatabaseUrl: "postgres://x" }).merge,
		).toBeUndefined();
	});

	it("passes through test_command from the file", () => {
		const out = resolveConfig({
			flagDatabaseUrl: "postgres://x",
			file: { merge: { test_command: ["pnpm", "test"] } },
		});
		expect(out.merge?.testCommand).toEqual(["pnpm", "test"]);
	});

	it("passes through repair_model from the file", () => {
		const out = resolveConfig({
			flagDatabaseUrl: "postgres://x",
			file: { merge: { test_command: ["npm", "test"], repair_model: "test/repair" } },
		});
		expect(out.merge?.repairModel).toBe("test/repair");
	});

	it("defaults timeout + staging worktree when the merge block is present but incomplete", () => {
		const out = resolveConfig({
			flagDatabaseUrl: "postgres://x",
			file: { merge: { test_command: ["npm", "test"] } },
		});
		expect(out.merge?.testTimeoutSeconds).toBe(DEFAULT_MERGE_TEST_TIMEOUT_SECONDS);
		expect(out.merge?.stagingWorktree).toBe(DEFAULT_MERGE_STAGING_WORKTREE);
	});

	it("respects explicit timeout and staging worktree overrides", () => {
		const out = resolveConfig({
			flagDatabaseUrl: "postgres://x",
			file: {
				merge: {
					test_command: ["npm", "test"],
					test_timeout_seconds: 30,
					staging_worktree: "/tmp/staging",
				},
			},
		});
		expect(out.merge?.testTimeoutSeconds).toBe(30);
		expect(out.merge?.stagingWorktree).toBe("/tmp/staging");
	});

	it("produces a merge block even when test_command is missing (daemon asserts later)", () => {
		const out = resolveConfig({
			flagDatabaseUrl: "postgres://x",
			file: { merge: {} },
		});
		expect(out.merge).toBeDefined();
		expect(out.merge?.testCommand).toBeUndefined();
		expect(out.merge?.testTimeoutSeconds).toBe(DEFAULT_MERGE_TEST_TIMEOUT_SECONDS);
		expect(out.merge?.stagingWorktree).toBe(DEFAULT_MERGE_STAGING_WORKTREE);
		expect(out.merge?.repairModel).toBeUndefined();
	});
});
