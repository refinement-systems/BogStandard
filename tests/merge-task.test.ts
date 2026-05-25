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
 * Tests for scripts/run-merge-worker.ts.
 *
 * vi.mock("../scripts/lib/agent-runner.js") is hoisted before any import so
 * @earendil-works/pi-agent-core and @earendil-works/pi-ai are never resolved;
 * they ship inside pi's global installation and are not installed for npm test.
 *
 * Integration tests (skipIf !isPostgresAvailable) exercise the full durable
 * merge flow through runMergeWorker with a real temp git repo + postgres DB.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Must be hoisted before any import that reaches the agent-runner module.
vi.mock("../scripts/lib/agent-runner.js", () => ({
	runAgentLoopContinue: vi.fn(),
	convertToLlm: vi.fn(),
	createReadTool: vi.fn((cwd: string) => ({ name: "read", cwd })),
	createGrepTool: vi.fn((cwd: string) => ({ name: "grep", cwd })),
	createFindTool: vi.fn((cwd: string) => ({ name: "find", cwd })),
	createLsTool: vi.fn((cwd: string) => ({ name: "ls", cwd })),
	createBashTool: vi.fn((cwd: string) => ({ name: "bash", cwd })),
	createEditTool: vi.fn((cwd: string) => ({ name: "edit", cwd })),
	createWriteTool: vi.fn((cwd: string) => ({ name: "write", cwd })),
	getModel: vi.fn(() => ({})),
	getEnvApiKey: vi.fn(() => undefined),
	Type: {
		Object: (_schema: unknown) => ({}),
		String: (_opts?: unknown) => ({}),
	},
}));

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { enqueueMergeTask } from "../agent/extensions/bogstandard/merge-queue.js";
import { getPool, issueCreate } from "../agent/extensions/bogstandard/db.js";
import {
	runMergeWorker,
	MainIsRedError,
	MergeFailedError,
	MergeFinalizationError,
	assertFinalizableMerge,
	finalizeMerge,
	prepareMainWorktreeSync,
	syncPreparedMainWorktrees,
	preflight,
	runTests,
	buildRepairAgentTools,
	resolveRepairModel,
} from "../scripts/run-merge-worker.js";
import {
	runAgentLoopContinue,
	getModel,
	createReadTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createBashTool,
	createEditTool,
	createWriteTool,
} from "../scripts/lib/agent-runner.js";

const { Client } = pg;
const execFileP = promisify(execFile);

const STAGING_RELATIVE = ".bogstandard/merge-staging";

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

// ── Unit tests (no postgres) ──────────────────────────────────────────────────

describe("MainIsRedError", () => {
	it("carries the test output and a descriptive message", () => {
		const err = new MainIsRedError("tests: FAILED");
		expect(err).toBeInstanceOf(Error);
		expect(err.output).toBe("tests: FAILED");
		expect(err.message).toContain("tests: FAILED");
		expect(err.name).toBe("MainIsRedError");
	});
});

describe("MergeFailedError", () => {
	it("identifies the failed issue and diagnosis", () => {
		const err = new MergeFailedError(12, "repair failed");
		expect(err).toBeInstanceOf(Error);
		expect(err.issueId).toBe(12);
		expect(err.diagnosis).toBe("repair failed");
		expect(err.message).toContain("issue 12");
		expect(err.name).toBe("MergeFailedError");
	});
});

describe("runTests", () => {
	it("returns exitCode 0 and non-empty output for a succeeding command", async () => {
		const result = await runTests(["echo", "hello"], process.cwd(), 5_000);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("hello");
	});

	it("returns non-zero exitCode for a failing command", async () => {
		// `false` always exits 1
		const result = await runTests(["false"], process.cwd(), 5_000);
		expect(result.exitCode).not.toBe(0);
	});

	it("truncates output that exceeds 200 lines", async () => {
		// Print 300 lines; trimOutput should drop the early ones.
		const cmd = [
			"node",
			"-e",
			"for(let i=0;i<300;i++)process.stdout.write('line '+i+'\\n'); process.exit(1)",
		];
		const result = await runTests(cmd, process.cwd(), 10_000);
		expect(result.output).toContain("...(truncated)");
		// The earliest lines should be gone
		expect(result.output).not.toContain("line 0\n");
		// The later lines should be present
		expect(result.output).toContain("line 299");
	});
});

describe("preflight", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		while (cleanupDirs.length > 0) {
			const dir = cleanupDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hard-resets a detached staging worktree to main and removes untracked files", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "bs-preflight-"));
		cleanupDirs.push(projectRoot);
		await git(projectRoot, ["init", "-q", "-b", "main"]);
		await git(projectRoot, ["config", "user.email", "test@example.com"]);
		await git(projectRoot, ["config", "user.name", "BogStandard Test"]);

		writeFileSync(join(projectRoot, "conflict.txt"), "base\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "base"]);

		await git(projectRoot, ["checkout", "-b", "tmp/issue"]);
		writeFileSync(join(projectRoot, "conflict.txt"), "issue\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "issue"]);
		const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
		await git(projectRoot, ["update-ref", "refs/bogstandard/issue-1", issueSha]);

		await git(projectRoot, ["checkout", "main"]);
		await git(projectRoot, ["branch", "-D", "tmp/issue"]);
		writeFileSync(join(projectRoot, "conflict.txt"), "main\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "main"]);

		const stagingCwd = join(projectRoot, STAGING_RELATIVE);
		await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE, "refs/heads/main"]);
		await execFileP("git", [
			"merge",
			"--no-ff",
			"--no-edit",
			"-m",
			"merge issue",
			"refs/bogstandard/issue-1",
		], { cwd: stagingCwd }).catch(() => {});
		writeFileSync(join(stagingCwd, "untracked.txt"), "leftover\n");

		await preflight(stagingCwd);

		const mainSha = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();
		const stagingHead = (await git(stagingCwd, ["rev-parse", "HEAD"])).trim();
		expect(stagingHead).toBe(mainSha);
		await expect(
			execFileP("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: stagingCwd }),
		).rejects.toBeTruthy();
		expect((await git(stagingCwd, ["status", "--porcelain=v1"])).trim()).toBe("");
	});

	it("fails before reset when a configured remote cannot be fetched", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "bs-preflight-remote-"));
		cleanupDirs.push(projectRoot);
		await git(projectRoot, ["init", "-q", "-b", "main"]);
		await git(projectRoot, ["config", "user.email", "test@example.com"]);
		await git(projectRoot, ["config", "user.name", "BogStandard Test"]);
		writeFileSync(join(projectRoot, "README.md"), "base\n");
		await git(projectRoot, ["add", "README.md"]);
		await git(projectRoot, ["commit", "-m", "base"]);
		await git(projectRoot, ["remote", "add", "origin", join(projectRoot, "missing-remote.git")]);

		const stagingCwd = join(projectRoot, STAGING_RELATIVE);
		await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE, "refs/heads/main"]);

		await expect(preflight(stagingCwd)).rejects.toThrow(/git fetch --quiet --all --prune failed/);
	});
});

describe("resolveRepairModel", () => {
	it("resolves a provider/model spec", () => {
		const model = { name: "model" };
		vi.mocked(getModel as unknown as (...a: unknown[]) => unknown).mockReturnValueOnce(model);
		expect(resolveRepairModel("provider/model-id")).toBe(model);
		expect(getModel).toHaveBeenCalledWith("provider", "model-id");
	});

	it("uses the task param before the daemon config fallback", () => {
		resolveRepairModel("task/model", "config/model");
		expect(getModel).toHaveBeenCalledWith("task", "model");
	});

	it("uses the daemon config fallback when the task param is absent", () => {
		resolveRepairModel(undefined, "config/model");
		expect(getModel).toHaveBeenCalledWith("config", "model");
	});

	it("allows slashes inside the model id", () => {
		resolveRepairModel("openrouter/deepseek/deepseek-v4-flash");
		expect(getModel).toHaveBeenCalledWith("openrouter", "deepseek/deepseek-v4-flash");
	});

	it("throws when no repair model is configured", () => {
		expect(() => resolveRepairModel(undefined)).toThrow(/bs-merge-repair-model/);
		expect(() => resolveRepairModel(undefined)).toThrow(/merge\.repair_model/);
	});

	it("throws on malformed specs", () => {
		expect(() => resolveRepairModel("missing-slash")).toThrow(/expected provider\/id/);
		expect(() => resolveRepairModel("/missing-provider")).toThrow(/expected provider\/id/);
		expect(() => resolveRepairModel("provider/")).toThrow(/expected provider\/id/);
	});

	it("throws when the model registry cannot resolve the spec", () => {
		vi.mocked(getModel as unknown as (...a: unknown[]) => unknown).mockReturnValueOnce(undefined);
		expect(() => resolveRepairModel("provider/missing")).toThrow(/Model not found: provider\/missing/);
	});
});

describe("buildRepairAgentTools", () => {
	it("builds the repair tool surface in prompt order for the staging worktree", () => {
		const stagingCwd = "/tmp/merge-staging";
		const bailOutTool = { name: "bail_out" } as any;

		const tools = buildRepairAgentTools(stagingCwd, bailOutTool);

		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"edit",
			"write",
			"bail_out",
		]);
		expect(tools.at(-1)).toBe(bailOutTool);
		for (const factory of [
			createReadTool,
			createGrepTool,
			createFindTool,
			createLsTool,
			createBashTool,
			createEditTool,
			createWriteTool,
		]) {
			expect(factory).toHaveBeenCalledWith(stagingCwd);
		}
	});
});

describe("assertFinalizableMerge", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		while (cleanupDirs.length > 0) {
			const dir = cleanupDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function initFinalizationRepo(prefix: string): Promise<string> {
		const projectRoot = mkdtempSync(join(tmpdir(), prefix));
		cleanupDirs.push(projectRoot);
		await git(projectRoot, ["init", "-q", "-b", "main"]);
		await git(projectRoot, ["config", "user.email", "test@example.com"]);
		await git(projectRoot, ["config", "user.name", "BogStandard Test"]);
		return projectRoot;
	}

	async function createNoFfMerge(): Promise<{
		projectRoot: string;
		refName: string;
		issueSha: string;
		mergeSha: string;
	}> {
		const projectRoot = await initFinalizationRepo("bs-finalize-ok-");
		const refName = "refs/bogstandard/issue-1";

		writeFileSync(join(projectRoot, "README.md"), "# Test\n");
		await git(projectRoot, ["add", "README.md"]);
		await git(projectRoot, ["commit", "-m", "init"]);

		await git(projectRoot, ["checkout", "-b", "tmp/issue"]);
		writeFileSync(join(projectRoot, "feature.txt"), "feature\n");
		await git(projectRoot, ["add", "feature.txt"]);
		await git(projectRoot, ["commit", "-m", "feature"]);
		const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
		await git(projectRoot, ["update-ref", refName, issueSha]);

		await git(projectRoot, ["checkout", "main"]);
		writeFileSync(join(projectRoot, "main.txt"), "main\n");
		await git(projectRoot, ["add", "main.txt"]);
		await git(projectRoot, ["commit", "-m", "main"]);
		await git(projectRoot, ["checkout", "--detach", "refs/heads/main"]);
		await git(projectRoot, ["merge", "--no-ff", "--no-edit", "-m", "merge issue", refName]);
		const mergeSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

		return { projectRoot, refName, issueSha, mergeSha };
	}

	it("accepts a clean no-ff merge containing main and the issue ref", async () => {
		const { projectRoot, refName, mergeSha } = await createNoFfMerge();

		await expect(assertFinalizableMerge(refName, mergeSha, projectRoot)).resolves.toBeUndefined();
	});

	it.each([
		["staged", async (projectRoot: string) => {
			writeFileSync(join(projectRoot, "staged.txt"), "staged\n");
			await git(projectRoot, ["add", "staged.txt"]);
		}],
		["unstaged", async (projectRoot: string) => {
			writeFileSync(join(projectRoot, "feature.txt"), "dirty\n");
		}],
		["untracked", async (projectRoot: string) => {
			writeFileSync(join(projectRoot, "untracked.txt"), "untracked\n");
		}],
	] as const)("rejects %s worktree changes", async (_label, dirty) => {
		const { projectRoot, refName, mergeSha } = await createNoFfMerge();
		await dirty(projectRoot);

		await expect(assertFinalizableMerge(refName, mergeSha, projectRoot)).rejects.toBeInstanceOf(
			MergeFinalizationError,
		);
	});

	it("rejects unmerged conflict paths", async () => {
		const projectRoot = await initFinalizationRepo("bs-finalize-conflict-");
		const refName = "refs/bogstandard/issue-1";

		writeFileSync(join(projectRoot, "conflict.txt"), "base\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "base"]);

		await git(projectRoot, ["checkout", "-b", "tmp/issue"]);
		writeFileSync(join(projectRoot, "conflict.txt"), "feature\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "feature"]);
		const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
		await git(projectRoot, ["update-ref", refName, issueSha]);

		await git(projectRoot, ["checkout", "main"]);
		writeFileSync(join(projectRoot, "conflict.txt"), "main\n");
		await git(projectRoot, ["add", "conflict.txt"]);
		await git(projectRoot, ["commit", "-m", "main"]);
		await git(projectRoot, ["checkout", "--detach", "refs/heads/main"]);
		await execFileP("git", ["merge", "--no-ff", "--no-edit", "-m", "merge issue", refName], {
			cwd: projectRoot,
		}).catch(() => {});
		const headSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

		await expect(assertFinalizableMerge(refName, headSha, projectRoot)).rejects.toBeInstanceOf(
			MergeFinalizationError,
		);
	});

	it("rejects HEAD that does not contain the issue ref", async () => {
		const projectRoot = await initFinalizationRepo("bs-finalize-wrong-ref-");
		const refName = "refs/bogstandard/issue-1";
		const otherRefName = "refs/bogstandard/issue-2";

		writeFileSync(join(projectRoot, "README.md"), "# Test\n");
		await git(projectRoot, ["add", "README.md"]);
		await git(projectRoot, ["commit", "-m", "init"]);

		await git(projectRoot, ["checkout", "-b", "tmp/issue-1"]);
		writeFileSync(join(projectRoot, "issue-1.txt"), "issue 1\n");
		await git(projectRoot, ["add", "issue-1.txt"]);
		await git(projectRoot, ["commit", "-m", "issue 1"]);
		await git(projectRoot, ["update-ref", refName, (await git(projectRoot, ["rev-parse", "HEAD"])).trim()]);

		await git(projectRoot, ["checkout", "main"]);
		await git(projectRoot, ["checkout", "-b", "tmp/issue-2"]);
		writeFileSync(join(projectRoot, "issue-2.txt"), "issue 2\n");
		await git(projectRoot, ["add", "issue-2.txt"]);
		await git(projectRoot, ["commit", "-m", "issue 2"]);
		await git(projectRoot, ["update-ref", otherRefName, (await git(projectRoot, ["rev-parse", "HEAD"])).trim()]);

		await git(projectRoot, ["checkout", "main"]);
		writeFileSync(join(projectRoot, "main.txt"), "main\n");
		await git(projectRoot, ["add", "main.txt"]);
		await git(projectRoot, ["commit", "-m", "main"]);
		await git(projectRoot, ["checkout", "--detach", "refs/heads/main"]);
		await git(projectRoot, ["merge", "--no-ff", "--no-edit", "-m", "merge other issue", otherRefName]);
		const mergeSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

		await expect(assertFinalizableMerge(refName, mergeSha, projectRoot)).rejects.toBeInstanceOf(
			MergeFinalizationError,
		);
	});

	it("rejects a linear fast-forward result with no merge commit", async () => {
		const projectRoot = await initFinalizationRepo("bs-finalize-linear-");
		const refName = "refs/bogstandard/issue-1";

		writeFileSync(join(projectRoot, "README.md"), "# Test\n");
		await git(projectRoot, ["add", "README.md"]);
		await git(projectRoot, ["commit", "-m", "init"]);

		await git(projectRoot, ["checkout", "-b", "tmp/issue"]);
		writeFileSync(join(projectRoot, "feature.txt"), "feature\n");
		await git(projectRoot, ["add", "feature.txt"]);
		await git(projectRoot, ["commit", "-m", "feature"]);
		const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
		await git(projectRoot, ["update-ref", refName, issueSha]);

		await git(projectRoot, ["checkout", "--detach", "refs/heads/main"]);
		await git(projectRoot, ["merge", refName]);
		const headSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

		await expect(assertFinalizableMerge(refName, headSha, projectRoot)).rejects.toBeInstanceOf(
			MergeFinalizationError,
		);
	});

	it("rejects repair success where HEAD equals repairStartSha", async () => {
		const { projectRoot, refName, mergeSha } = await createNoFfMerge();

		await expect(
			assertFinalizableMerge(refName, mergeSha, projectRoot, { repairStartSha: mergeSha }),
		).rejects.toBeInstanceOf(MergeFinalizationError);
	});

	it("accepts repair success with a committed fix on top of the merge commit", async () => {
		const { projectRoot, refName, mergeSha } = await createNoFfMerge();
		writeFileSync(join(projectRoot, "repair.txt"), "repair\n");
		await git(projectRoot, ["add", "repair.txt"]);
		await git(projectRoot, ["commit", "-m", "repair"]);
		const repairedSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

		await expect(
			assertFinalizableMerge(refName, repairedSha, projectRoot, { repairStartSha: mergeSha }),
		).resolves.toBeUndefined();
	});

	it("accepts the DB-recorded issue head when the live issue ref is gone", async () => {
		const { projectRoot, refName, issueSha, mergeSha } = await createNoFfMerge();
		await git(projectRoot, ["update-ref", "-d", refName]);

		await expect(
			assertFinalizableMerge(refName, mergeSha, projectRoot, { issueHeadSha: issueSha }),
		).resolves.toBeUndefined();
	});
});

describe("main worktree sync helpers", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		while (cleanupDirs.length > 0) {
			const dir = cleanupDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function setupMainSyncRepo(prefix: string): Promise<{
		projectRoot: string;
		stagingCwd: string;
		newMainSha: string;
	}> {
		const projectRoot = mkdtempSync(join(tmpdir(), prefix));
		cleanupDirs.push(projectRoot);
		await initRepo(projectRoot);
		writeFileSync(join(projectRoot, ".gitignore"), ".bogstandard/\n");
		writeFileSync(join(projectRoot, "README.md"), "# Test\n");
		await git(projectRoot, ["add", ".gitignore", "README.md"]);
		await git(projectRoot, ["commit", "-m", "init"]);
		await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE]);
		const stagingCwd = join(projectRoot, STAGING_RELATIVE);
		writeFileSync(join(stagingCwd, "feature.txt"), "feature\n");
		await git(stagingCwd, ["add", "feature.txt"]);
		await git(stagingCwd, ["commit", "-m", "new main"]);
		const newMainSha = (await git(stagingCwd, ["rev-parse", "HEAD"])).trim();
		return { projectRoot, stagingCwd, newMainSha };
	}

	it("returns no plan when no worktree has main attached", async () => {
		const { projectRoot, stagingCwd } = await setupMainSyncRepo("bs-main-sync-none-");
		await git(projectRoot, ["checkout", "--detach"]);

		await expect(prepareMainWorktreeSync(stagingCwd)).resolves.toEqual([]);
	});

	it("syncs a clean attached main checkout after refs/heads/main advances", async () => {
		const { projectRoot, stagingCwd, newMainSha } =
			await setupMainSyncRepo("bs-main-sync-clean-");
		const plan = await prepareMainWorktreeSync(stagingCwd);
		expect(plan).toHaveLength(1);

		await git(stagingCwd, ["update-ref", "refs/heads/main", newMainSha]);
		await syncPreparedMainWorktrees(plan);

		expect((await git(projectRoot, ["rev-parse", "HEAD"])).trim()).toBe(newMainSha);
		expect((await git(projectRoot, ["status", "--porcelain"])).trim()).toBe("");
		expect(existsSync(join(projectRoot, "feature.txt"))).toBe(true);
	});

	it("does not overwrite changes that appear after the precheck", async () => {
		const { projectRoot, stagingCwd, newMainSha } =
			await setupMainSyncRepo("bs-main-sync-race-");
		const plan = await prepareMainWorktreeSync(stagingCwd);

		await git(stagingCwd, ["update-ref", "refs/heads/main", newMainSha]);
		writeFileSync(join(projectRoot, "local.txt"), "operator edit\n");

		await expect(syncPreparedMainWorktrees(plan)).rejects.toBeInstanceOf(
			MergeFinalizationError,
		);
		expect(existsSync(join(projectRoot, "feature.txt"))).toBe(false);
		expect(existsSync(join(projectRoot, "local.txt"))).toBe(true);
	});
});

// ── Integration helpers ───────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileP("git", args, { cwd });
	return result.stdout;
}

function writeConfig(
	projectRoot: string,
	dbUrl: string,
	stagingWorktree: string,
	testCommand: string[] = ["echo", "ok"],
): void {
	mkdirSync(resolve(projectRoot, ".bogstandard"), { recursive: true });
	writeFileSync(
		resolve(projectRoot, ".bogstandard", "config.json"),
		JSON.stringify(
			{
				database_url: dbUrl,
				agent_id: "merge-task-test",
				stale_lock_timeout_minutes: 60,
				merge: {
					test_command: testCommand,
					test_timeout_seconds: 30,
					staging_worktree: stagingWorktree,
					repair_model: "test/repair",
				},
			},
			null,
			2,
		) + "\n",
	);
}

async function initRepo(projectRoot: string): Promise<void> {
	await git(projectRoot, ["init", "-q"]);
	await git(projectRoot, ["config", "user.email", "test@example.com"]);
	await git(projectRoot, ["config", "user.name", "BogStandard Test"]);
}

async function seedIssueAndBranch(
	dbUrl: string,
	issueId: number,
	refName: string,
	headSha: string,
	baseSha: string,
): Promise<void> {
	const client = new Client({ connectionString: dbUrl });
	await client.connect();
	try {
		await client.query(
			`INSERT INTO issue_branches (issue_id, ref_name, head_sha, base_sha)
			 VALUES ($1, $2, $3, $4)`,
			[issueId, refName, headSha, baseSha],
		);
	} finally {
		await client.end();
	}
}

async function fetchIssueAndBranch(
	dbUrl: string,
	issueId: number,
): Promise<{ phase: string; merged_at: Date | null; merge_sha: string | null } | undefined> {
	const client = new Client({ connectionString: dbUrl });
	await client.connect();
	try {
		const res = await client.query<{ phase: string; merged_at: Date | null; merge_sha: string | null }>(
			`SELECT i.phase, ib.merged_at, ib.merge_sha
			   FROM issues i
			   LEFT JOIN issue_branches ib ON ib.issue_id = i.id
			  WHERE i.id = $1`,
			[issueId],
		);
		return res.rows[0];
	} finally {
		await client.end();
	}
}

async function withPool<T>(
	dbUrl: string,
	fn: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
	const pool = new pg.Pool({ connectionString: dbUrl, allowExitOnIdle: true });
	try {
		return await fn(pool);
	} finally {
		await pool.end();
	}
}

/**
 * Build a project where the issue ref merges cleanly with main:
 *   A (README.md)  ← main
 *    \
 *     B (feature.txt)  ← refs/bogstandard/issue-N
 *
 * Returns projectRoot and the DB issueId.
 */
async function setupCleanMerge(
	dbUrl: string,
): Promise<{ projectRoot: string; issueId: number }> {
	const projectRoot = mkdtempSync(join(tmpdir(), "bs-merge-task-clean-"));

	await initRepo(projectRoot);

	// commit A: README
	writeFileSync(join(projectRoot, ".gitignore"), ".bogstandard/\n");
	writeFileSync(join(projectRoot, "README.md"), "# Test\n");
	await git(projectRoot, ["add", ".gitignore", "README.md"]);
	await git(projectRoot, ["commit", "-m", "init"]);
	const mainSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

	// commit B: feature (from A, no conflict with main)
	await git(projectRoot, ["checkout", "-b", "tmp/feat"]);
	writeFileSync(join(projectRoot, "feature.txt"), "# Feature\n");
	await git(projectRoot, ["add", "feature.txt"]);
	await git(projectRoot, ["commit", "-m", "add feature"]);
	const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

	// Publish the issue ref and return to main
	await git(projectRoot, ["update-ref", "refs/bogstandard/issue-tmp", issueSha]);
	await git(projectRoot, ["checkout", "main"]);
	await git(projectRoot, ["branch", "-D", "tmp/feat"]);

	// Create the staging worktree (detached at main)
	await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE]);

	// Create the DB issue in merging_pending phase
	const issueId = await issueCreate(null as any, {
		title: "Add feature file",
		priority: "medium",
		phase: "merging_pending",
	});

	// Rename the issue ref to the real id-based name
	const refName = `refs/bogstandard/issue-${issueId}`;
	await git(projectRoot, ["update-ref", refName, issueSha]);
	await git(projectRoot, ["update-ref", "-d", "refs/bogstandard/issue-tmp"]);

	// Seed issue_branches
	await seedIssueAndBranch(dbUrl, issueId, refName, issueSha, mainSha);

	// Write config.json
	writeConfig(projectRoot, dbUrl, STAGING_RELATIVE);

	return { projectRoot, issueId };
}

async function setupFinalizableMerge(
	dbUrl: string,
): Promise<{
	projectRoot: string;
	issueId: number;
	stagingCwd: string;
	refName: string;
	mergeSha: string;
}> {
	const { projectRoot, issueId } = await setupCleanMerge(dbUrl);
	const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
	const refName = `refs/bogstandard/issue-${issueId}`;

	const client = new Client({ connectionString: dbUrl });
	await client.connect();
	try {
		await client.query(`UPDATE issues SET phase = 'merging' WHERE id = $1`, [issueId]);
	} finally {
		await client.end();
	}

	await git(stagingCwd, ["merge", "--no-ff", "--no-edit", "-m", "merge issue", refName]);
	const mergeSha = (await git(stagingCwd, ["rev-parse", "HEAD"])).trim();

	return { projectRoot, issueId, stagingCwd, refName, mergeSha };
}

/**
 * Build a project where the issue ref conflicts with main:
 *   A (README.md)  ← base
 *    \
 *     B (conflict.txt = "main version")  ← refs/heads/main
 *     C (conflict.txt = "feature version")  ← refs/bogstandard/issue-N
 *
 * B and C both diverge from A and both add/edit conflict.txt with different
 * content, so merging C into B will produce a merge conflict.
 */
async function setupConflict(
	dbUrl: string,
): Promise<{ projectRoot: string; issueId: number }> {
	const projectRoot = mkdtempSync(join(tmpdir(), "bs-merge-task-conflict-"));

	await initRepo(projectRoot);

	// commit A: base
	writeFileSync(join(projectRoot, ".gitignore"), ".bogstandard/\n");
	writeFileSync(join(projectRoot, "README.md"), "# Test\n");
	await git(projectRoot, ["add", ".gitignore", "README.md"]);
	await git(projectRoot, ["commit", "-m", "init"]);
	const baseSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();

	// commit C: issue branch from A — write conflict.txt with feature content
	await git(projectRoot, ["checkout", "-b", "tmp/issue"]);
	writeFileSync(join(projectRoot, "conflict.txt"), "feature version\n");
	await git(projectRoot, ["add", "conflict.txt"]);
	await git(projectRoot, ["commit", "-m", "feature change"]);
	const issueSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
	await git(projectRoot, ["update-ref", "refs/bogstandard/issue-tmp", issueSha]);

	// Return to main and advance it — write conflict.txt with main content
	await git(projectRoot, ["checkout", "main"]);
	await git(projectRoot, ["branch", "-D", "tmp/issue"]);
	writeFileSync(join(projectRoot, "conflict.txt"), "main version\n");
	await git(projectRoot, ["add", "conflict.txt"]);
	await git(projectRoot, ["commit", "-m", "main change"]);

	// Create staging worktree (detached at current main)
	await git(projectRoot, ["worktree", "add", "--detach", STAGING_RELATIVE]);

	// Create the DB issue in merging_pending phase
	const issueId = await issueCreate(null as any, {
		title: "Conflicting feature",
		priority: "low",
		phase: "merging_pending",
	});

	// Rename ref to the real id-based name
	const refName = `refs/bogstandard/issue-${issueId}`;
	await git(projectRoot, ["update-ref", refName, issueSha]);
	await git(projectRoot, ["update-ref", "-d", "refs/bogstandard/issue-tmp"]);

	// Seed issue_branches
	await seedIssueAndBranch(dbUrl, issueId, refName, issueSha, baseSha);

	// Write config.json
	writeConfig(projectRoot, dbUrl, STAGING_RELATIVE);

	return { projectRoot, issueId };
}

// ── Integration tests ─────────────────────────────────────────────────────────

describe.skipIf(!isPostgresAvailable())("merge-task integration", () => {
	const handle = useTempDb();
	const cleanupDirs: string[] = [];

	beforeEach(async () => {
		// Wipe queue state between tests so a previous test's task can't be
		// re-claimed by the next test's `runMergeWorker --once`. Particularly
		// important for the MainIsRed scenario, which intentionally leaves the
		// task in `state='pending'` for the operator to retry.
		await getPool().query(
			`TRUNCATE merge_task_steps, merge_tasks RESTART IDENTITY CASCADE`,
		);
	});

	afterEach(() => {
		vi.resetAllMocks();
		while (cleanupDirs.length > 0) {
			const dir = cleanupDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clean merge → issue transitions to done with merged_at set", async () => {
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:clean:${issueId}` });
		expect(enq.created).toBe(true);

		await runMergeWorker({
			projectRoot,
			once: true,
			log: silentLog,
		});

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merged_at).not.toBeNull();
		expect(row?.merge_sha).not.toBeNull();
		expect((await git(projectRoot, ["rev-parse", "HEAD"])).trim()).toBe(row?.merge_sha);
		expect((await git(projectRoot, ["status", "--porcelain"])).trim()).toBe("");
		expect(existsSync(join(projectRoot, "feature.txt"))).toBe(true);
	}, 30_000);

	it("finalizeMerge can be called twice after the first call deletes the issue ref", async () => {
		const { projectRoot, issueId, stagingCwd, refName, mergeSha } =
			await setupFinalizableMerge(handle.url());
		cleanupDirs.push(projectRoot);

		await withPool(handle.url(), async (pool) => {
			await finalizeMerge(pool, issueId, refName, mergeSha, stagingCwd);
			expect(
				(await git(stagingCwd, ["for-each-ref", "--format=%(refname)", refName])).trim(),
			).toBe("");

			await finalizeMerge(pool, issueId, refName, mergeSha, stagingCwd);
		});

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merged_at).not.toBeNull();
		expect(row?.merge_sha).toBe(mergeSha);
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mergeSha);
		expect((await git(projectRoot, ["status", "--porcelain"])).trim()).toBe("");
		expect(existsSync(join(projectRoot, "feature.txt"))).toBe(true);
	}, 30_000);

	it("finalizeMerge accepts an already-done row with the same merge SHA and cleans up the ref", async () => {
		const { projectRoot, issueId, stagingCwd, refName, mergeSha } =
			await setupFinalizableMerge(handle.url());
		cleanupDirs.push(projectRoot);

		await git(stagingCwd, ["update-ref", "refs/heads/main", mergeSha]);
		const client = new Client({ connectionString: handle.url() });
		await client.connect();
		try {
			await client.query(
				`UPDATE issues SET phase = 'done' WHERE id = $1`,
				[issueId],
			);
			await client.query(
				`UPDATE issue_branches SET merged_at = now(), merge_sha = $1 WHERE issue_id = $2`,
				[mergeSha, issueId],
			);
		} finally {
			await client.end();
		}

		await withPool(handle.url(), async (pool) => {
			await finalizeMerge(pool, issueId, refName, mergeSha, stagingCwd);
		});

		expect(
			(await git(stagingCwd, ["for-each-ref", "--format=%(refname)", refName])).trim(),
		).toBe("");
		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merge_sha).toBe(mergeSha);
		expect((await git(projectRoot, ["status", "--porcelain"])).trim()).toBe("");
		expect(existsSync(join(projectRoot, "feature.txt"))).toBe(true);
	}, 30_000);

	it("finalizeMerge rejects a dirty attached main checkout before advancing refs/heads/main", async () => {
		const { projectRoot, issueId, stagingCwd, refName, mergeSha } =
			await setupFinalizableMerge(handle.url());
		cleanupDirs.push(projectRoot);
		const mainBefore = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();
		writeFileSync(join(projectRoot, "local.txt"), "operator edit\n");

		await withPool(handle.url(), async (pool) => {
			await expect(
				finalizeMerge(pool, issueId, refName, mergeSha, stagingCwd),
			).rejects.toBeInstanceOf(MergeFinalizationError);
		});

		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mainBefore);
		expect(existsSync(join(projectRoot, "local.txt"))).toBe(true);
		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("merging");
		expect(row?.merge_sha).toBeNull();
	}, 30_000);

	it.each([
		["different", "deadbeef"],
		["missing", null],
	] as const)(
		"finalizeMerge rejects a done row with %s merge SHA and preserves the issue ref",
		async (_label, storedMergeSha) => {
			const { projectRoot, issueId, stagingCwd, refName, mergeSha } =
				await setupFinalizableMerge(handle.url());
			cleanupDirs.push(projectRoot);

			await git(stagingCwd, ["update-ref", "refs/heads/main", mergeSha]);
			const client = new Client({ connectionString: handle.url() });
			await client.connect();
			try {
				await client.query(`UPDATE issues SET phase = 'done' WHERE id = $1`, [issueId]);
				await client.query(
					`UPDATE issue_branches SET merged_at = now(), merge_sha = $1 WHERE issue_id = $2`,
					[storedMergeSha, issueId],
				);
			} finally {
				await client.end();
			}

			await withPool(handle.url(), async (pool) => {
				await expect(
					finalizeMerge(pool, issueId, refName, mergeSha, stagingCwd),
				).rejects.toBeInstanceOf(MergeFinalizationError);
			});

			expect(
				(await git(stagingCwd, ["for-each-ref", "--format=%(refname)", refName])).trim(),
			).toBe(refName);
			const row = await fetchIssueAndBranch(handle.url(), issueId);
			expect(row?.phase).toBe("done");
			expect(row?.merge_sha).toBe(storedMergeSha);
		},
		30_000,
	);

	it("conflict + repair agent bail_out → issue transitions to merge_failed", async () => {
		const { projectRoot, issueId } = await setupConflict(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const mainBefore = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();

		// Mock: agent loop adds a bail_out message and returns
		vi.mocked(runAgentLoopContinue as unknown as (...a: unknown[]) => unknown).mockImplementationOnce(
			async (_context: unknown, _config: unknown, persistEvent: unknown) => {
				const persist = persistEvent as (event: unknown) => Promise<void>;
				await persist({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "bail_out",
								params: { reason: "unresolvable conflict in conflict.txt" },
							},
						],
						timestamp: Date.now(),
					},
				});
			},
		);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:conflict:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MergeFailedError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("merge_failed");
		expect(row?.merged_at).toBeNull();
		expect(row?.merge_sha).toBeNull();
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mainBefore);
		expect(
			(await git(stagingCwd, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/bogstandard/issue-${issueId}`,
			])).trim(),
		).toBe(`refs/bogstandard/issue-${issueId}`);
	}, 30_000);

	it("pre-merge tests fail → MainIsRedError; issue stays in merging_pending", async () => {
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);

		// Overwrite the config so the daemon runs a command that always fails.
		writeConfig(projectRoot, handle.url(), STAGING_RELATIVE, ["false"]);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:red-main:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MainIsRedError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		// Issue never reached the merging phase (let alone done), and no merge
		// happened — `merging_pending` is what the publish step left.
		expect(row?.phase).toBe("merging_pending");
		expect(row?.merged_at).toBeNull();

		// Ref is still present — the daemon left the handoff intact.
		const refList = await git(resolve(projectRoot, STAGING_RELATIVE), [
			"for-each-ref",
			"--format=%(refname)",
			`refs/bogstandard/issue-${issueId}`,
		]);
		expect(refList.trim()).toBe(`refs/bogstandard/issue-${issueId}`);
	}, 30_000);

	it("idempotency: worker accepts already-done issue with matching merge SHA", async () => {
		const { projectRoot, issueId, stagingCwd, refName, mergeSha } =
			await setupFinalizableMerge(handle.url());
		cleanupDirs.push(projectRoot);

		await git(stagingCwd, ["update-ref", "refs/heads/main", mergeSha]);
		const client = new Client({ connectionString: handle.url() });
		await client.connect();
		try {
			await client.query(`UPDATE issues SET phase = 'done' WHERE id = $1`, [issueId]);
			await client.query(
				`UPDATE issue_branches SET merged_at = now(), merge_sha = $1 WHERE issue_id = $2`,
				[mergeSha, issueId],
			);
		} finally {
			await client.end();
		}

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:already-merged:${issueId}` });
		expect(enq.created).toBe(true);

		await runMergeWorker({
			projectRoot,
			once: true,
			log: silentLog,
		});

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merged_at).not.toBeNull();
		expect(row?.merge_sha).toBe(mergeSha);
		expect(
			(await git(stagingCwd, ["for-each-ref", "--format=%(refname)", refName])).trim(),
		).toBe("");
	}, 30_000);

	it("idempotency: done without merge metadata fails and preserves the handoff ref", async () => {
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const refName = `refs/bogstandard/issue-${issueId}`;

		// Force the issue into a terminal phase before the daemon claims it.
		const client = new Client({ connectionString: handle.url() });
		await client.connect();
		try {
			await client.query(`UPDATE issues SET phase = 'done' WHERE id = $1`, [issueId]);
		} finally {
			await client.end();
		}

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:already-done:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MergeFinalizationError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merged_at).toBeNull();
		expect(row?.merge_sha).toBeNull();
		expect(
			(await git(stagingCwd, ["for-each-ref", "--format=%(refname)", refName])).trim(),
		).toBe(refName);
	}, 30_000);

	it("post-merge tests fail (no conflict) → repair agent path → merge_failed on bail", async () => {
		// Reuse setupCleanMerge; then point the test command at a script that
		// passes when run on plain main (pre-merge) and fails once a sentinel
		// file (added by the issue ref) is present in the tree (post-merge).
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const mainBefore = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();

		// The issue ref already adds `feature.txt`. Use it as the sentinel.
		const testScript = resolve(projectRoot, ".bogstandard", "test.sh");
		writeFileSync(
			testScript,
			"#!/bin/sh\nif [ -f feature.txt ]; then echo 'tests fail'; exit 1; fi\necho ok\n",
		);
		await execFileP("chmod", ["+x", testScript]);
		writeConfig(projectRoot, handle.url(), STAGING_RELATIVE, [testScript]);

		vi.mocked(runAgentLoopContinue as unknown as (...a: unknown[]) => unknown).mockImplementationOnce(
			async (_context: unknown, _config: unknown, persistEvent: unknown) => {
				const persist = persistEvent as (event: unknown) => Promise<void>;
				await persist({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "bail_out",
								params: { reason: "post-merge tests cannot be fixed without rewriting history" },
							},
						],
						timestamp: Date.now(),
					},
				});
			},
		);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:post-fail:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MergeFailedError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("merge_failed");
		expect(row?.merged_at).toBeNull();
		expect(row?.merge_sha).toBeNull();
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mainBefore);
		expect(
			(await git(stagingCwd, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/bogstandard/issue-${issueId}`,
			])).trim(),
		).toBe(`refs/bogstandard/issue-${issueId}`);
	}, 30_000);

	it("conflict repair success without committing → merge_failed and preserves handoff", async () => {
		const { projectRoot, issueId } = await setupConflict(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const mainBefore = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();

		vi.mocked(runAgentLoopContinue as unknown as (...a: unknown[]) => unknown).mockImplementationOnce(
			async () => {
				// No bail_out message: the worker interprets this as agent success.
			},
		);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:conflict-uncommitted:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MergeFailedError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("merge_failed");
		expect(row?.merged_at).toBeNull();
		expect(row?.merge_sha).toBeNull();
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mainBefore);
		expect(
			(await git(stagingCwd, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/bogstandard/issue-${issueId}`,
			])).trim(),
		).toBe(`refs/bogstandard/issue-${issueId}`);
	}, 30_000);

	it("post-merge repair with uncommitted passing edits → merge_failed and main is not advanced", async () => {
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const mainBefore = (await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim();

		const testScript = resolve(projectRoot, ".bogstandard", "test.sh");
		writeFileSync(
			testScript,
			"#!/bin/sh\nif [ ! -f feature.txt ]; then echo ok; exit 0; fi\nif grep -q fixed feature.txt; then echo ok; exit 0; fi\necho 'needs repair'; exit 1\n",
		);
		await execFileP("chmod", ["+x", testScript]);
		writeConfig(projectRoot, handle.url(), STAGING_RELATIVE, [testScript]);

		vi.mocked(runAgentLoopContinue as unknown as (...a: unknown[]) => unknown).mockImplementationOnce(
			async () => {
				writeFileSync(resolve(stagingCwd, "feature.txt"), "fixed\n");
			},
		);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:post-uncommitted:${issueId}` });
		expect(enq.created).toBe(true);

		await expect(
			runMergeWorker({
				projectRoot,
				once: true,
				log: silentLog,
			}),
		).rejects.toBeInstanceOf(MergeFailedError);

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("merge_failed");
		expect(row?.merged_at).toBeNull();
		expect(row?.merge_sha).toBeNull();
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(mainBefore);
		expect(
			(await git(stagingCwd, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/bogstandard/issue-${issueId}`,
			])).trim(),
		).toBe(`refs/bogstandard/issue-${issueId}`);
	}, 30_000);

	it("successful committed repair → done with merge SHA containing the issue ref", async () => {
		const { projectRoot, issueId } = await setupCleanMerge(handle.url());
		cleanupDirs.push(projectRoot);
		const stagingCwd = resolve(projectRoot, STAGING_RELATIVE);
		const issueSha = (await git(projectRoot, ["rev-parse", `refs/bogstandard/issue-${issueId}`])).trim();

		const testScript = resolve(projectRoot, ".bogstandard", "test.sh");
		writeFileSync(
			testScript,
			"#!/bin/sh\nif [ ! -f feature.txt ]; then echo ok; exit 0; fi\nif grep -q fixed feature.txt; then echo ok; exit 0; fi\necho 'needs repair'; exit 1\n",
		);
		await execFileP("chmod", ["+x", testScript]);
		writeConfig(projectRoot, handle.url(), STAGING_RELATIVE, [testScript]);

		vi.mocked(runAgentLoopContinue as unknown as (...a: unknown[]) => unknown).mockImplementationOnce(
			async () => {
				writeFileSync(resolve(stagingCwd, "feature.txt"), "fixed\n");
				await git(stagingCwd, ["add", "feature.txt"]);
				await git(stagingCwd, ["commit", "-m", "repair feature"]);
			},
		);

		const enq = await enqueueMergeTask(getPool(), { issueId, idempotencyKey: `merge:post-committed:${issueId}` });
		expect(enq.created).toBe(true);

		await runMergeWorker({
			projectRoot,
			once: true,
			log: silentLog,
		});

		const row = await fetchIssueAndBranch(handle.url(), issueId);
		expect(row?.phase).toBe("done");
		expect(row?.merged_at).not.toBeNull();
		expect(row?.merge_sha).toBeTruthy();
		expect((await git(projectRoot, ["rev-parse", "refs/heads/main"])).trim()).toBe(row?.merge_sha);
		await expect(
			execFileP("git", [
				"merge-base",
				"--is-ancestor",
				issueSha,
				row!.merge_sha!,
			], { cwd: stagingCwd }),
		).resolves.toBeTruthy();
	}, 30_000);
});
