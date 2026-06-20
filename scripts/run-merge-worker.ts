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
 * bs-merge-worker — the merge-flow daemon.
 *
 *   bs-merge-worker [--once] [--database-url <url>] [--agent-id <id>]
 *
 * Connects to the configured postgres database, registers the `merge-issue`
 * handler against the `bogstandard_merge` queue, and runs until
 * SIGINT/SIGTERM (or until a single task lands, with `--once`).
 *
 * The handler implements the 7-step durable merge flow from §8 of
 * plan_merge_flow.md:
 *
 *   1. load_issue          — load issue + issue_branches row
 *   2. preflight_main      — reset staging worktree to HEAD of main
 *   3. pre_merge_tests     — run test command; exit(2) on failure (MainIsRed)
 *   4. attempt_merge       — git merge --no-ff; captures conflicts
 *   5. post_merge_tests    — run tests after clean merge
 *   6. invoke_repair_agent — pi-agent-core loop when conflicts/tests fail
 *   7. finalize            — update refs/heads/main, DB, transition to done
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
	loadConfig,
	type ResolvedConfig,
} from "../agent/extensions/bogstandard/config.js";
import {
	configureDb,
	transitionPhase,
	issueComment,
	type Phase,
	type PhaseTransitionInput,
} from "../agent/extensions/bogstandard/db.js";
import {
	MERGE_QUEUE_NAME,
	MERGE_TASK_NAME,
} from "../agent/extensions/bogstandard/merge-handoff.js";
import {
	runDaemon,
	runOnce,
	type MergeTaskContext,
} from "./lib/merge-runtime.js";
import {
	buildMergeRepairSystemPrompt,
} from "../agent/extensions/bogstandard/prompts.js";
import {
	assertMergeConfig,
	findAttachedMainWorktrees,
	isStagingWorktreeRegistered,
	parseWorktreesPorcelain,
	stagingWorktreeMissingMessage,
	type AssertedMergeConfig,
	type WorktreeEntry,
} from "./lib/merge-worker.js";
import {
	runAgentLoopContinue,
	convertToLlm,
	createReadTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	getModel,
	getEnvApiKey,
	Type,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
} from "./lib/agent-runner.js";

const { Pool } = pg;
const execFileP = promisify(execFile);

// ── Error types ───────────────────────────────────────────────────────────────

/** Tests on `main` are failing before we even attempt the merge. */
export class MainIsRedError extends Error {
	constructor(public readonly output: string) {
		super(`Tests on main are failing. Output:\n${output}`);
		this.name = "MainIsRedError";
	}
}

/** The staging worktree is not safe to land on main. */
export class MergeFinalizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MergeFinalizationError";
	}
}

/** A merge reached `merge_failed`; stop the daemon and leave staging for inspection. */
export class MergeFailedError extends Error {
	constructor(
		public readonly issueId: number,
		public readonly diagnosis: string,
	) {
		super(
			`Merge repair failed for issue ${issueId}; inspect staging worktree and restart bs-merge-worker`,
		);
		this.name = "MergeFailedError";
	}
}

// ── CLI types ─────────────────────────────────────────────────────────────────

interface CliArgs {
	databaseUrl?: string;
	agentId?: string;
	once: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = { once: false };
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
			case "--once":
				out.once = true;
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
		"Usage: bs-merge-worker [--once] [--database-url <url>] [--agent-id <id>]\n" +
			"\n" +
			"Long-running daemon that processes the bogstandard_merge queue.\n" +
			"Run from the target project's directory (reads .bogstandard/config.json).\n" +
			"\n" +
			"  --once                   Process at most one task, then exit cleanly.\n" +
			"  --database-url <url>     Override .bogstandard/config.json's database_url.\n" +
			"  --agent-id <id>          Override .bogstandard/config.json's agent_id.\n",
	);
}

// ── Merge task params ─────────────────────────────────────────────────────────

export type MergeIssueParams = { issueId: number; repairModel?: string };

// ── DB row types ──────────────────────────────────────────────────────────────

interface IssueRow {
	id: number;
	title: string;
	phase: Phase;
	current_version_id: number;
}

interface IssueBranchRow {
	ref_name: string;
	head_sha: string;
	base_sha: string;
	merged_at: Date | null;
	merge_sha: string | null;
}

interface LoadedIssue {
	issue: IssueRow;
	branch: IssueBranchRow;
}

interface MergeFinalizationState {
	issue: Pick<IssueRow, "id" | "phase" | "current_version_id">;
	branch: IssueBranchRow;
}

// ── Pure step helpers ─────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const result = await execFileP("git", args, { cwd });
		return { stdout: result.stdout, stderr: result.stderr ?? "", code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
		// execFile rejects on non-zero exit; still return structured result
		if (typeof e.code === "number") {
			return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
		}
		throw err;
	}
}

export async function loadIssueBranch(pool: pg.Pool, issueId: number): Promise<LoadedIssue> {
	const issueRes = await pool.query<IssueRow>(
		`SELECT i.id, iv.title, i.phase, i.current_version_id
		   FROM issues i
		   JOIN issue_versions iv ON iv.id = i.current_version_id
		  WHERE i.id = $1`,
		[issueId],
	);
	if (issueRes.rowCount === 0) throw new Error(`Issue ${issueId} not found`);
	const issue = issueRes.rows[0];

	const branchRes = await pool.query<IssueBranchRow>(
		`SELECT ref_name, head_sha, base_sha, merged_at, merge_sha FROM issue_branches WHERE issue_id = $1`,
		[issueId],
	);
	if (branchRes.rowCount === 0) {
		throw new Error(`No issue_branches row for issue ${issueId}`);
	}
	return { issue, branch: branchRes.rows[0] };
}

async function loadMergeFinalizationState(
	pool: pg.Pool,
	issueId: number,
): Promise<MergeFinalizationState> {
	const res = await pool.query<{
		id: string;
		phase: Phase;
		current_version_id: string;
		ref_name: string;
		head_sha: string;
		base_sha: string;
		merged_at: Date | null;
		merge_sha: string | null;
	}>(
		`SELECT i.id,
		        i.phase,
		        i.current_version_id,
		        ib.ref_name,
		        ib.head_sha,
		        ib.base_sha,
		        ib.merged_at,
		        ib.merge_sha
		   FROM issues i
		   JOIN issue_branches ib ON ib.issue_id = i.id
		  WHERE i.id = $1`,
		[issueId],
	);
	if (res.rowCount === 0) {
		throw new MergeFinalizationError(
			`Cannot finalize merge: issue ${issueId} or issue_branches row not found.`,
		);
	}
	const row = res.rows[0];
	return {
		issue: {
			id: Number(row.id),
			phase: row.phase,
			current_version_id: Number(row.current_version_id),
		},
		branch: {
			ref_name: row.ref_name,
			head_sha: row.head_sha,
			base_sha: row.base_sha,
			merged_at: row.merged_at,
			merge_sha: row.merge_sha,
		},
	};
}

export async function preflight(cwd: string): Promise<void> {
	const remotes = await git(["remote"], cwd);
	if (remotes.code !== 0) {
		throw new Error(`git remote failed before preflight fetch: ${remotes.stderr}`);
	}
	if (remotes.stdout.trim() !== "") {
		const fetch = await git(["fetch", "--quiet", "--all", "--prune"], cwd);
		if (fetch.code !== 0) {
			throw new Error(
				`git fetch --quiet --all --prune failed before preflight reset: ${fetch.stderr}`,
			);
		}
	}

	const attachedBranch = await git(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
	if (attachedBranch.code === 0) {
		throw new Error(
			`staging worktree must be detached before preflight reset; currently on ${attachedBranch.stdout.trim()}`,
		);
	}

	const reset = await git(["reset", "--hard", "refs/heads/main"], cwd);
	if (reset.code !== 0) {
		throw new Error(`git reset --hard refs/heads/main failed: ${reset.stderr}`);
	}

	// --detach avoids the git worktree branch-lock (main may be checked out in the
	// main worktree); we only need the working tree to match refs/heads/main HEAD.
	const checkout = await git(["checkout", "--detach", "refs/heads/main"], cwd);
	if (checkout.code !== 0) {
		throw new Error(`git checkout --detach refs/heads/main failed: ${checkout.stderr}`);
	}

	const clean = await git(["clean", "-fdx"], cwd);
	if (clean.code !== 0) throw new Error(`git clean failed: ${clean.stderr}`);
}

export interface TestResult {
	exitCode: number;
	output: string;
}

export async function runTests(
	testCommand: string[],
	cwd: string,
	timeoutMs: number,
): Promise<TestResult> {
	const [cmd, ...args] = testCommand;
	if (!cmd) throw new Error("test_command is empty");
	try {
		const result = await execFileP(cmd, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
		});
		const output = trimOutput((result.stdout ?? "") + (result.stderr ?? ""), 200);
		return { exitCode: 0, output };
	} catch (err) {
		const e = err as { code?: number | string; stdout?: string; stderr?: string };
		const exitCode = typeof e.code === "number" ? e.code : 1;
		const output = trimOutput((e.stdout ?? "") + (e.stderr ?? ""), 200);
		return { exitCode, output };
	}
}

function trimOutput(raw: string, maxLines: number): string {
	const lines = raw.split("\n");
	if (lines.length <= maxLines) return raw;
	return `...(truncated)\n${lines.slice(-maxLines).join("\n")}`;
}

export interface MergeAttemptResult {
	merged: boolean;
	conflicts: string[];
	mergeSha?: string;
}

export async function attemptMerge(
	refName: string,
	issueId: number,
	title: string,
	cwd: string,
): Promise<MergeAttemptResult> {
	// Idempotency check: if HEAD is already ahead of main after a clean tree,
	// a previous run already merged.
	const statusResult = await git(["status", "--short"], cwd);
	if (statusResult.code === 0 && statusResult.stdout.trim() === "") {
		const revList = await git(["rev-list", "--count", "refs/heads/main..HEAD"], cwd);
		if (revList.code === 0 && parseInt(revList.stdout.trim(), 10) > 0) {
			const headRes = await git(["rev-parse", "HEAD"], cwd);
			return { merged: true, conflicts: [], mergeSha: headRes.stdout.trim() };
		}
	}

	const msg = `Merge issue #${issueId}: ${title}`;
	const mergeResult = await git(
		["merge", "--no-ff", "--no-edit", "-m", msg, refName],
		cwd,
	);

	if (mergeResult.code === 0) {
		const headRes = await git(["rev-parse", "HEAD"], cwd);
		return { merged: true, conflicts: [], mergeSha: headRes.stdout.trim() };
	}

	// Non-zero exit: likely conflicts. Parse `git status --short` for UU/AA etc.
	const statusAfter = await git(["status", "--short"], cwd);
	const conflicts = statusAfter.stdout
		.split("\n")
		.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l))
		.map((l) => l.slice(3).trim());

	return { merged: false, conflicts };
}

export interface FinalizableMergeOptions {
	repairStartSha?: string;
	issueHeadSha?: string;
}

export interface PreparedMainWorktreeSync {
	path: string;
	oldMainSha: string;
}

export async function assertFinalizableMerge(
	refName: string,
	mergeSha: string,
	cwd: string,
	options: FinalizableMergeOptions = {},
): Promise<void> {
	const head = await git(["rev-parse", "HEAD"], cwd);
	if (head.code !== 0) {
		throw new MergeFinalizationError(`git rev-parse HEAD failed: ${head.stderr}`);
	}
	const headSha = head.stdout.trim();
	if (headSha !== mergeSha) {
		throw new MergeFinalizationError(
			`Cannot finalize merge: HEAD is ${headSha}, expected ${mergeSha}.`,
		);
	}

	const status = await git(["status", "--porcelain"], cwd);
	if (status.code !== 0) {
		throw new MergeFinalizationError(`git status --porcelain failed: ${status.stderr}`);
	}
	if (status.stdout.trim() !== "") {
		throw new MergeFinalizationError(
			`Cannot finalize merge: staging worktree is dirty:\n${status.stdout.trim()}`,
		);
	}

	const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
	if (unmerged.code !== 0) {
		throw new MergeFinalizationError(
			`git diff --name-only --diff-filter=U failed: ${unmerged.stderr}`,
		);
	}
	if (unmerged.stdout.trim() !== "") {
		throw new MergeFinalizationError(
			`Cannot finalize merge: unresolved conflict paths remain:\n${unmerged.stdout.trim()}`,
		);
	}

	const mainAncestor = await git(["merge-base", "--is-ancestor", "refs/heads/main", "HEAD"], cwd);
	if (mainAncestor.code !== 0) {
		throw new MergeFinalizationError(
			"Cannot finalize merge: HEAD does not contain refs/heads/main.",
		);
	}

	const issueHead = options.issueHeadSha ?? refName;
	const issueAncestor = await git(["merge-base", "--is-ancestor", issueHead, "HEAD"], cwd);
	if (issueAncestor.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot finalize merge: HEAD does not contain ${options.issueHeadSha ? `issue head ${options.issueHeadSha}` : refName}.`,
		);
	}

	const mergeCommit = await git(
		["rev-list", "--merges", "--max-count=1", "refs/heads/main..HEAD"],
		cwd,
	);
	if (mergeCommit.code !== 0) {
		throw new MergeFinalizationError(
			`git rev-list --merges --max-count=1 refs/heads/main..HEAD failed: ${mergeCommit.stderr}`,
		);
	}
	if (mergeCommit.stdout.trim() === "") {
		throw new MergeFinalizationError(
			"Cannot finalize merge: no merge commit exists between refs/heads/main and HEAD.",
		);
	}

	if (options.repairStartSha) {
		const repairAncestor = await git(
			["merge-base", "--is-ancestor", options.repairStartSha, "HEAD"],
			cwd,
		);
		if (repairAncestor.code !== 0) {
			throw new MergeFinalizationError(
				`Cannot finalize repaired merge: HEAD does not contain repair start ${options.repairStartSha}.`,
			);
		}
		if (headSha === options.repairStartSha) {
			throw new MergeFinalizationError(
				"Cannot finalize repaired merge: repair produced no new commit.",
			);
		}
	}
}

export async function finalizeMerge(
	pool: pg.Pool,
	issueId: number,
	refName: string,
	mergeSha: string,
	cwd: string,
	options: FinalizableMergeOptions = {},
): Promise<void> {
	const state = await loadMergeFinalizationState(pool, issueId);
	if (state.branch.ref_name !== refName) {
		throw new MergeFinalizationError(
			`Cannot finalize merge: DB ref ${state.branch.ref_name} does not match task ref ${refName}.`,
		);
	}

	if (isCompletedMergeState(state, mergeSha)) {
		await assertMainContainsMerge(mergeSha, cwd);
		const syncPlan = await prepareAlreadyDoneMainWorktreeSync(mergeSha, cwd);
		await syncPreparedMainWorktrees(syncPlan);
		await deleteIssueRef(refName, cwd);
		return;
	}

	if (isTerminalPhase(state.issue.phase)) {
		throw inconsistentTerminalMergeError(issueId, state, mergeSha);
	}
	if (state.issue.phase !== "merging") {
		throw new MergeFinalizationError(
			`Cannot finalize merge for issue ${issueId}: phase is '${state.issue.phase}', expected 'merging'.`,
		);
	}

	await assertFinalizableMerge(refName, mergeSha, cwd, {
		...options,
		issueHeadSha: state.branch.head_sha,
	});

	const syncPlan = await prepareMainWorktreeSync(cwd);

	const updateMain = await git(["update-ref", "refs/heads/main", mergeSha], cwd);
	if (updateMain.code !== 0) {
		throw new Error(`git update-ref refs/heads/main failed: ${updateMain.stderr}`);
	}

	await markMergeDone(pool, issueId, mergeSha);
	await syncPreparedMainWorktrees(syncPlan);

	const completed = await loadMergeFinalizationState(pool, issueId);
	if (!isCompletedMergeState(completed, mergeSha)) {
		throw new MergeFinalizationError(
			`Cannot delete ${refName}: DB did not record issue ${issueId} as done at ${mergeSha}.`,
		);
	}
	await deleteIssueRef(refName, cwd);
}

export async function prepareMainWorktreeSync(
	cwd: string,
): Promise<PreparedMainWorktreeSync[]> {
	const currentMain = await git(["rev-parse", "refs/heads/main"], cwd);
	if (currentMain.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot prepare main worktree sync: git rev-parse refs/heads/main failed: ${currentMain.stderr}`,
		);
	}
	const oldMainSha = currentMain.stdout.trim();
	const candidates = await listAttachedMainWorktrees(cwd);
	const plan: PreparedMainWorktreeSync[] = [];

	for (const candidate of candidates) {
		const status = await git(["status", "--porcelain"], candidate.path);
		if (status.code !== 0) {
			throw new MergeFinalizationError(
				`Cannot prepare main worktree sync for ${candidate.path}: git status --porcelain failed: ${status.stderr}`,
			);
		}
		if (status.stdout.trim() !== "") {
			throw new MergeFinalizationError(
				`Cannot finalize merge: attached main worktree is dirty at ${candidate.path}:\n${status.stdout.trim()}\n` +
					"Commit, stash, or remove those changes, then restart bs-merge-worker.",
			);
		}

		const head = await git(["rev-parse", "HEAD"], candidate.path);
		if (head.code !== 0) {
			throw new MergeFinalizationError(
				`Cannot prepare main worktree sync for ${candidate.path}: git rev-parse HEAD failed: ${head.stderr}`,
			);
		}
		const headSha = head.stdout.trim();
		if (headSha !== oldMainSha) {
			throw new MergeFinalizationError(
				`Cannot finalize merge: attached main worktree at ${candidate.path} is at ${headSha}, expected ${oldMainSha}.`,
			);
		}

		plan.push({ path: candidate.path, oldMainSha });
	}

	return plan;
}

export async function syncPreparedMainWorktrees(
	plan: PreparedMainWorktreeSync[],
): Promise<void> {
	for (const target of plan) {
		await syncPreparedMainWorktree(target);
	}
}

async function prepareAlreadyDoneMainWorktreeSync(
	mergeSha: string,
	cwd: string,
): Promise<PreparedMainWorktreeSync[]> {
	const candidates = await listAttachedMainWorktrees(cwd);
	if (candidates.length === 0) return [];

	const parent = await git(["rev-parse", `${mergeSha}^1`], cwd);
	if (parent.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot prepare main worktree sync: git rev-parse ${mergeSha}^1 failed: ${parent.stderr}`,
		);
	}
	const oldMainSha = parent.stdout.trim();
	return candidates.map((candidate) => ({ path: candidate.path, oldMainSha }));
}

async function listAttachedMainWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	const list = await git(["worktree", "list", "--porcelain"], cwd);
	if (list.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot list git worktrees while finalizing merge: ${list.stderr}`,
		);
	}
	const stagingPath = canonicalize(cwd);
	const entries = parseWorktreesPorcelain(list.stdout).map((entry) => ({
		...entry,
		path: canonicalize(entry.path),
	}));
	return findAttachedMainWorktrees(entries, stagingPath, "/");
}

async function syncPreparedMainWorktree(
	target: PreparedMainWorktreeSync,
): Promise<void> {
	const status = await git(["status", "--porcelain"], target.path);
	if (status.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot sync attached main worktree at ${target.path}: git status --porcelain failed: ${status.stderr}`,
		);
	}
	if (status.stdout.trim() === "") return;

	await assertWorktreeStillMatchesCommit(target.path, target.oldMainSha);

	const reset = await git(["reset", "--hard", "refs/heads/main"], target.path);
	if (reset.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot sync attached main worktree at ${target.path}: git reset --hard refs/heads/main failed: ${reset.stderr}`,
		);
	}

	const postStatus = await git(["status", "--porcelain"], target.path);
	if (postStatus.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot verify attached main worktree at ${target.path}: git status --porcelain failed: ${postStatus.stderr}`,
		);
	}
	if (postStatus.stdout.trim() !== "") {
		throw new MergeFinalizationError(
			`Attached main worktree at ${target.path} is still dirty after sync:\n${postStatus.stdout.trim()}`,
		);
	}
}

async function assertWorktreeStillMatchesCommit(path: string, sha: string): Promise<void> {
	const untracked = await git(["ls-files", "--others", "--exclude-standard"], path);
	if (untracked.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot verify attached main worktree at ${path}: git ls-files failed: ${untracked.stderr}`,
		);
	}
	if (untracked.stdout.trim() !== "") {
		throw new MergeFinalizationError(
			`Cannot sync attached main worktree at ${path}: untracked files appeared after precheck:\n${untracked.stdout.trim()}`,
		);
	}

	const indexMatchesOldMain = await git(["diff", "--cached", "--quiet", sha, "--"], path);
	if (indexMatchesOldMain.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot sync attached main worktree at ${path}: index no longer matches pre-merge main ${sha}.`,
		);
	}

	const worktreeMatchesIndex = await git(["diff-files", "--quiet"], path);
	if (worktreeMatchesIndex.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot sync attached main worktree at ${path}: tracked changes appeared after precheck.`,
		);
	}
}

function isTerminalPhase(phase: Phase): boolean {
	return (
		phase === "done" ||
		phase === "merge_failed" ||
		phase === "aborted" ||
		phase === "archived"
	);
}

function isCompletedMergeState(state: MergeFinalizationState, mergeSha: string): boolean {
	return (
		state.issue.phase === "done" &&
		state.branch.merged_at !== null &&
		state.branch.merge_sha === mergeSha
	);
}

function inconsistentTerminalMergeError(
	issueId: number,
	state: MergeFinalizationState,
	mergeSha: string,
): MergeFinalizationError {
	return new MergeFinalizationError(
		`Cannot finalize merge for issue ${issueId}: terminal phase '${state.issue.phase}' has ` +
			`merged_at=${state.branch.merged_at === null ? "NULL" : "set"} and ` +
			`merge_sha=${state.branch.merge_sha ?? "NULL"}, expected merge_sha=${mergeSha}.`,
	);
}

async function assertMainContainsMerge(mergeSha: string, cwd: string): Promise<void> {
	const mainContainsMerge = await git(
		["merge-base", "--is-ancestor", mergeSha, "refs/heads/main"],
		cwd,
	);
	if (mainContainsMerge.code !== 0) {
		throw new MergeFinalizationError(
			`Cannot finalize merge: refs/heads/main does not contain ${mergeSha}.`,
		);
	}
}

async function deleteIssueRef(refName: string, cwd: string): Promise<void> {
	await git(["update-ref", "-d", refName], cwd).catch(() => {});
}

async function markMergeDone(
	pool: pg.Pool,
	issueId: number,
	mergeSha: string,
): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const issueRes = await client.query<{
			phase: Phase;
			current_version_id: string;
		}>(
			`SELECT phase, current_version_id
			   FROM issues
			  WHERE id = $1
			  FOR UPDATE`,
			[issueId],
		);
		if (issueRes.rowCount === 0) {
			throw new MergeFinalizationError(`Cannot finalize merge: issue ${issueId} not found.`);
		}

		const branchRes = await client.query<{
			merged_at: Date | null;
			merge_sha: string | null;
		}>(
			`SELECT merged_at, merge_sha
			   FROM issue_branches
			  WHERE issue_id = $1
			  FOR UPDATE`,
			[issueId],
		);
		if (branchRes.rowCount === 0) {
			throw new MergeFinalizationError(
				`Cannot finalize merge: no issue_branches row for issue ${issueId}.`,
			);
		}

		const issue = issueRes.rows[0];
		const branch = branchRes.rows[0];
		if (issue.phase === "done" && branch.merged_at !== null && branch.merge_sha === mergeSha) {
			await client.query("COMMIT");
			return;
		}
		if (isTerminalPhase(issue.phase)) {
			throw new MergeFinalizationError(
				`Cannot finalize merge for issue ${issueId}: terminal phase '${issue.phase}' has ` +
					`merged_at=${branch.merged_at === null ? "NULL" : "set"} and ` +
					`merge_sha=${branch.merge_sha ?? "NULL"}, expected merge_sha=${mergeSha}.`,
			);
		}
		if (issue.phase !== "merging") {
			throw new MergeFinalizationError(
				`Cannot finalize merge for issue ${issueId}: phase is '${issue.phase}', expected 'merging'.`,
			);
		}

		await client.query(
			`UPDATE issue_branches
			    SET merged_at = COALESCE(merged_at, now()),
			        merge_sha = $1
			  WHERE issue_id = $2`,
			[mergeSha, issueId],
		);

		const updateIssue = await client.query(
			`UPDATE issues
			    SET phase = 'done',
			        phase_started_at = now(),
			        updated_at = now(),
			        current_agent_id = NULL
			  WHERE id = $1
			    AND phase = 'merging'`,
			[issueId],
		);
		if (updateIssue.rowCount === 0) {
			throw new MergeFinalizationError(
				`Cannot finalize merge for issue ${issueId}: phase changed before completion.`,
			);
		}

		await client.query(
			`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata)
			      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				issueId,
				Number(issue.current_version_id),
				"merging",
				"done",
				null,
				"merged to main",
				JSON.stringify({ merge_sha: mergeSha }),
			],
		);

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

export async function finalizeFailedMerge(
	pool: pg.Pool,
	issueId: number,
	diagnosis: string,
): Promise<void> {
	// Post the bail diagnosis as a comment
	try {
		await issueComment(null as any, issueId, "result",
			`Merge repair agent bailed out:\n\n${diagnosis}`);
	} catch {
		// best-effort: comment failure should not block the phase transition
	}

	// Transition to merge_failed; ignore if already there (idempotent retry)
	try {
		await transitionPhase(null as any, {
			issueId,
			to: "merge_failed",
			agentId: null,
			reason: "repair agent bailed out",
			metadata: { diagnosis },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// "precondition failed" means the phase already advanced (idempotent)
		if (!msg.includes("precondition failed")) throw err;
	}

	throw new MergeFailedError(issueId, diagnosis);
}

// ── Repair agent loop ─────────────────────────────────────────────────────────

type AgentRunResult = "success" | "bail";

type MessageLogEntry = { message: AgentMessage };

/**
 * Run the pi-agent-core loop with message-log checkpoints.
 */
export async function invokeRepairAgentLoop(
	ctx: MergeTaskContext,
	systemPrompt: string,
	userMessage: string,
	tools: AgentTool[],
	model: ReturnType<typeof getModel>,
	apiKey?: string,
): Promise<AgentRunResult> {
	const messages: AgentMessage[] = [];

	// Replay completed message checkpoints from a previous attempt
	let nextHandle = await ctx.beginStep<MessageLogEntry>("message");
	while (nextHandle.done) {
		messages.push(nextHandle.state!.message);
		nextHandle = await ctx.beginStep<MessageLogEntry>("message");
	}

	const context: AgentContext = { systemPrompt, tools, messages };

	const persistEvent = async (event: AgentEvent) => {
		if (event.type !== "message_end") return;
		await ctx.completeStep(nextHandle, { message: event.message });
		context.messages.push(event.message);
		nextHandle = await ctx.beginStep<MessageLogEntry>("message");
	};

	const last = context.messages.at(-1);
	if (!last) {
		// First attempt: persist the user message, then continue
		const userMsg: AgentMessage = {
			role: "user",
			content: userMessage,
			timestamp: Date.now(),
		};
		await ctx.completeStep(nextHandle, { message: userMsg });
		context.messages.push(userMsg);
		nextHandle = await ctx.beginStep<MessageLogEntry>("message");
	} else if (last.role === "assistant") {
		// Already finished on a previous attempt
		return detectOutcome(context.messages);
	}

	await runAgentLoopContinue(context, {
		model,
		convertToLlm,
		...(apiKey ? { apiKey } : {}),
		getApiKey: (provider: string) => getEnvApiKey(provider),
	}, persistEvent);

	return detectOutcome(context.messages);
}

function detectOutcome(messages: AgentMessage[]): AgentRunResult {
	// Check if any assistant message in the log contains a bail_out tool call
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content = (msg as { content: Array<{ type: string; name?: string }> }).content;
		if (Array.isArray(content) && content.some((c) => c.type === "toolCall" && c.name === "bail_out")) {
			return "bail";
		}
	}
	return "success";
}

function buildRepairUserMessage(
	mergeResult: MergeAttemptResult,
	testResult: TestResult | undefined,
	testCommand: string[],
): string {
	const parts: string[] = [];

	if (!mergeResult.merged && mergeResult.conflicts.length > 0) {
		parts.push(
			`## Merge conflicts\n\nThe following files have conflicts:\n${mergeResult.conflicts.map((f) => `- ${f}`).join("\n")}`,
		);
	} else if (!mergeResult.merged) {
		parts.push("## Merge failed\n\nThe merge failed. Inspect `git status` for details.");
	}

	if (testResult && testResult.exitCode !== 0) {
		parts.push(
			`## Test failures\n\nCommand: \`${testCommand.join(" ")}\`\n\nExit code: ${testResult.exitCode}\n\n\`\`\`\n${testResult.output}\n\`\`\``,
		);
	}

	return parts.join("\n\n") || "Inspect the working tree for issues that need resolution.";
}

export function buildRepairAgentTools(
	stagingCwd: string,
	bailOutTool: AgentTool,
): AgentTool[] {
	return [
		createReadTool(stagingCwd),
		createGrepTool(stagingCwd),
		createFindTool(stagingCwd),
		createLsTool(stagingCwd),
		createBashTool(stagingCwd),
		createEditTool(stagingCwd),
		createWriteTool(stagingCwd),
		bailOutTool,
	];
}

// ── Full merge handler (stage 7 + 8) ─────────────────────────────────────────

export interface MergeDeps {
	pool: pg.Pool;
	stagingCwd: string;
	testCommand: string[];
	testTimeoutMs: number;
	repairModel?: string;
}

export async function mergeIssueHandler(
	params: MergeIssueParams,
	ctx: MergeTaskContext,
	deps: MergeDeps,
): Promise<void> {
	const { pool, stagingCwd, testCommand, testTimeoutMs, repairModel } = deps;

	// Step 1: load_issue
	const loaded = await ctx.step("load_issue", () =>
		loadIssueBranch(pool, params.issueId),
	);

	// Idempotency guards: already finished on a previous attempt. A completed
	// merge is valid only when both the issue phase and durable merge SHA agree.
	if (
		loaded.issue.phase === "done" &&
		loaded.branch.merged_at !== null &&
		loaded.branch.merge_sha !== null
	) {
		console.log(
			`[merge-worker] issue ${params.issueId} already merged (merge_sha=${loaded.branch.merge_sha}); skipping`,
		);
		await assertMainContainsMerge(loaded.branch.merge_sha, stagingCwd);
		await deleteIssueRef(loaded.branch.ref_name, stagingCwd);
		return;
	}
	if (loaded.issue.phase === "done" || loaded.branch.merged_at !== null) {
		throw inconsistentTerminalMergeError(params.issueId, loaded, loaded.branch.merge_sha ?? "<unknown>");
	}
	if (
		loaded.issue.phase === "merge_failed" ||
		loaded.issue.phase === "aborted" ||
		loaded.issue.phase === "archived"
	) {
		console.log(
			`[merge-worker] issue ${params.issueId} already in terminal phase '${loaded.issue.phase}'; skipping`,
		);
		return;
	}

	// Step 2: preflight_main
	await ctx.step("preflight_main", () => preflight(stagingCwd));

	// Step 3: pre_merge_tests — main being red is a hard, non-retriable
	// condition. Throw so the CLI entry point can translate it to exit
	// code 2; tests catch the throw and assert state without tearing
	// down the test runner.
	//
	// Claim must happen AFTER pre_merge_tests so MainIsRed leaves the
	// issue in `merging_pending` (per plan_merge_flow.md §8): "If exit !=
	// 0: throw a special 'MainIsRed' error … Issue stays in
	// 'merging_pending'."
	const preTests = await ctx.step("pre_merge_tests", () =>
		runTests(testCommand, stagingCwd, testTimeoutMs),
	);
	if (preTests.exitCode !== 0) {
		throw new MainIsRedError(preTests.output);
	}

	// Claim: transition merging_pending → merging
	await ctx.step("claim", () =>
		transitionPhase(null as any, {
			issueId: loaded.issue.id,
			to: "merging",
			agentId: null,
			reason: "daemon claimed",
		}),
	);

	// Step 4: attempt_merge
	const mergeResult = await ctx.step("attempt_merge", () =>
		attemptMerge(
			loaded.branch.ref_name,
			loaded.issue.id,
			loaded.issue.title,
			stagingCwd,
		),
	);

	let mergeSha = mergeResult.mergeSha;

	if (mergeResult.merged && mergeSha) {
		// Step 5: post_merge_tests
		const postTests = await ctx.step("post_merge_tests", () =>
			runTests(testCommand, stagingCwd, testTimeoutMs),
		);

		if (postTests.exitCode === 0) {
			// Happy path → finalize
			await ctx.step("finalize", () =>
				finalizeMerge(pool, loaded.issue.id, loaded.branch.ref_name, mergeSha!, stagingCwd),
			);
			console.log(`[merge-worker] issue ${params.issueId} merged to main`);
			return;
		}

		// Clean merge but tests fail → repair agent
		// Step 6: invoke_repair_agent
		await invokeRepairAgentStep(
			ctx, pool, params, loaded, mergeResult, postTests, testCommand, testTimeoutMs, stagingCwd, repairModel,
		);
		return;
	}

	// Step 4 produced conflicts → repair agent (step 6)
	await invokeRepairAgentStep(
		ctx, pool, params, loaded, mergeResult, undefined, testCommand, testTimeoutMs, stagingCwd, repairModel,
	);
}

async function invokeRepairAgentStep(
	ctx: MergeTaskContext,
	pool: pg.Pool,
	params: MergeIssueParams,
	loaded: LoadedIssue,
	mergeResult: MergeAttemptResult,
	failedTests: TestResult | undefined,
	testCommand: string[],
	testTimeoutMs: number,
	stagingCwd: string,
	daemonRepairModel: string | undefined,
): Promise<void> {
	// Transition to merge_repair before starting the agent
	await transitionPhase(null as any, {
		issueId: loaded.issue.id,
		to: "merge_repair",
		agentId: null,
		reason: mergeResult.merged ? "post-merge tests failed" : "merge conflict",
	});

	const model = resolveRepairModel(params.repairModel, daemonRepairModel);

	const systemPrompt = buildMergeRepairSystemPrompt(
		loaded.issue.id,
		loaded.issue.title,
		testCommand.join(" "),
	);

	const userMessage = buildRepairUserMessage(mergeResult, failedTests, testCommand);

	const repairStart = await git(["rev-parse", "HEAD"], stagingCwd);
	if (repairStart.code !== 0) {
		throw new Error(`git rev-parse HEAD before repair failed: ${repairStart.stderr}`);
	}
	const repairStartSha = repairStart.stdout.trim();

	// Build the bail_out tool
	let bailReason: string | undefined;
	const bailOutTool: AgentTool = {
		name: "bail_out",
		label: "Bail Out",
		description:
			"Signal that the merge conflict or test failure cannot be fixed without rewriting history or making unrelated changes. Call this with a one-paragraph diagnosis, then stop.",
		parameters: Type.Object({
			reason: Type.String({
				description: "One-paragraph diagnosis of why the merge cannot be repaired",
			}),
		}),
		async execute(_id: string, params: { reason: string }) {
			bailReason = params.reason;
			return {
				content: [
					{
						type: "text" as const,
						text: "Bail recorded. Stop now — do not call any more tools. Send your final diagnosis message and end.",
					},
				],
				terminate: true,
			};
		},
	};

	const outcome = await invokeRepairAgentLoop(
		ctx,
		systemPrompt,
		userMessage,
		buildRepairAgentTools(stagingCwd, bailOutTool),
		model,
	);

	if (outcome === "bail") {
		const diagnosis = bailReason ?? "Agent bailed without providing a diagnosis.";
		console.log(`[merge-worker] repair agent bailed on issue ${loaded.issue.id}: ${diagnosis}`);
		await finalizeFailedMerge(pool, loaded.issue.id, diagnosis);
		return;
	}

	// Agent returned success: transition back to merging, re-run tests, finalize
	await transitionPhase(null as any, {
		issueId: loaded.issue.id,
		to: "merging",
		agentId: null,
		reason: "repair agent succeeded",
	});

	// Re-run post-merge tests
	const reTests = await ctx.step("post_merge_tests_after_repair", () =>
		runTests(testCommand, stagingCwd, testTimeoutMs),
	);
	if (reTests.exitCode !== 0) {
		// Tests still failing after agent claimed success — bail
		const diagnosis = `Repair agent returned success but tests still fail.\n\nTest output:\n${reTests.output}`;
		await finalizeFailedMerge(pool, loaded.issue.id, diagnosis);
		return;
	}

	// Capture the current HEAD (the repaired merge commit)
	const headRes = await git(["rev-parse", "HEAD"], stagingCwd);
	const mergeSha = headRes.stdout.trim();

	try {
		await ctx.step("finalize_after_repair", () =>
			finalizeMerge(pool, loaded.issue.id, loaded.branch.ref_name, mergeSha, stagingCwd, {
				repairStartSha,
			}),
		);
	} catch (err) {
		if (!(err instanceof MergeFinalizationError)) throw err;
		const diagnosis =
			"Repair agent returned success and tests passed, but the repaired merge is not finalizable.\n\n" +
			err.message;
		await finalizeFailedMerge(pool, loaded.issue.id, diagnosis);
		return;
	}
	console.log(`[merge-worker] issue ${loaded.issue.id} merged to main after repair`);
}

export function resolveRepairModel(
	taskSpec: string | undefined,
	daemonSpec?: string,
): ReturnType<typeof getModel> {
	const resolved = taskSpec ?? daemonSpec;
	if (!resolved) {
		throw new Error(
			"Merge repair needs a model. Pass --bs-merge-repair-model or --bs-impl-model during /bs-task, or set worker.models.phases.merge_repair, worker.models.merge_repair, worker.models.implement, or merge.repair_model in .bogstandard/config.json.",
		);
	}
	const slash = resolved.indexOf("/");
	if (slash <= 0 || slash === resolved.length - 1) {
		throw new Error(`Invalid repair model spec '${resolved}' — expected provider/id`);
	}
	const provider = resolved.slice(0, slash);
	const id = resolved.slice(slash + 1);
	const model = getModel(provider as any, id as any);
	if (!model) throw new Error(`Model not found: ${resolved}`);
	return model;
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

/**
 * Resolve symlinks where possible so the macOS `/var` → `/private/var`
 * symlink (and similar) doesn't trip up the path comparison.
 */
function canonicalize(path: string): string {
	const abs = resolve(path);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

async function defaultVerifyStagingWorktree(
	projectRoot: string,
	stagingWorktree: string,
): Promise<void> {
	const absStaging = resolve(projectRoot, stagingWorktree);
	let stdout: string;
	try {
		const result = await execFileP(
			"git",
			["worktree", "list", "--porcelain"],
			{ cwd: projectRoot },
		);
		stdout = result.stdout;
	} catch (err) {
		const e = err as { stderr?: string; message?: string };
		throw new Error(
			`bs-merge-worker: failed to list git worktrees in ${projectRoot}: ${
				e.stderr?.trim() || e.message || String(err)
			}`,
		);
	}
	const entries = parseWorktreesPorcelain(stdout).map((entry) => ({
		...entry,
		path: canonicalize(entry.path),
	}));
	const canonicalStaging = canonicalize(absStaging);
	if (!isStagingWorktreeRegistered(entries, canonicalStaging, projectRoot)) {
		throw new Error(stagingWorktreeMissingMessage(absStaging));
	}
}

function buildConfigPath(projectRoot: string): string {
	return resolve(projectRoot, ".bogstandard", "config.json");
}

function defaultWorkerId(agentId: string): string {
	return `bs-merge-worker:${agentId}:${process.pid}`;
}

export interface RunMergeWorkerOptions {
	projectRoot: string;
	flagDatabaseUrl?: string;
	flagAgentId?: string;
	once?: boolean;
	shutdownSignal?: Promise<void>;
	workerId?: string;
	verifyStagingWorktree?: (
		projectRoot: string,
		stagingWorktree: string,
	) => Promise<void>;
	log?: Pick<Console, "log" | "warn" | "error">;
	/**
	 * Override the merge-issue task handler. Defaults to the real implementation.
	 * Tests use this to exercise daemon lifecycle without running real git/DB operations.
	 */
	taskHandler?: (params: MergeIssueParams, ctx: MergeTaskContext) => Promise<void>;
}

export async function runMergeWorker(opts: RunMergeWorkerOptions): Promise<void> {
	const log = opts.log ?? console;
	const cfg: ResolvedConfig = loadConfig({
		projectRoot: opts.projectRoot,
		flagDatabaseUrl: opts.flagDatabaseUrl,
		flagAgentId: opts.flagAgentId,
	});
	const configPath = buildConfigPath(opts.projectRoot);
	const merge: AssertedMergeConfig = assertMergeConfig(cfg, configPath);

	const verify = opts.verifyStagingWorktree ?? defaultVerifyStagingWorktree;
	await verify(opts.projectRoot, merge.stagingWorktree);

	// Configure the db module so transitionPhase / issueComment can use getPool()
	configureDb(cfg);

	const pool = new Pool({ connectionString: cfg.databaseUrl, allowExitOnIdle: true });
	const stagingCwd = resolve(opts.projectRoot, merge.stagingWorktree);
	const deps: MergeDeps = {
		pool,
		stagingCwd,
		testCommand: merge.testCommand,
		testTimeoutMs: merge.testTimeoutSeconds * 1000,
		repairModel: merge.repairModel,
	};

	const workerId = opts.workerId ?? defaultWorkerId(cfg.agentId);
	const handler = opts.taskHandler ?? ((params: MergeIssueParams, ctx: MergeTaskContext) =>
		mergeIssueHandler(params, ctx, deps));

	// MainIsRedError is transient: tests on main are failing through no fault
	// of the worker's commit. The task is re-queued (state='pending') so the
	// next bs-merge-worker run (after the operator fixes main) picks it up.
	// All other errors — including MergeFailedError, where the issue itself
	// has already transitioned to `merge_failed` — are terminal: task goes to
	// `state='failed'` and the daemon exits so staging can be inspected.
	const isTransient = (err: unknown): boolean => err instanceof MainIsRedError;

	if (opts.once) {
		log.log(
			`[merge-worker] --once mode; worker id=${workerId}; queue=${MERGE_QUEUE_NAME}`,
		);
		try {
			await runOnce({ pool, handler, workerId, isTransientError: isTransient, log });
		} finally {
			await pool.end().catch((err) => log.warn("pool end error:", err));
		}
		return;
	}

	log.log(
		`[merge-worker] starting; worker id=${workerId}; queue=${MERGE_QUEUE_NAME}; concurrency=1`,
	);
	const daemon = runDaemon({ pool, handler, workerId, isTransientError: isTransient, log });

	// `daemon.exited` rejects if the handler ever throws; convert to a settled
	// promise so we can race it against the external shutdown signal.
	let daemonError: unknown;
	const daemonSettled = daemon.exited.then(
		() => "stopped" as const,
		(err) => {
			daemonError = err;
			return "errored" as const;
		},
	);

	const externalShutdown = opts.shutdownSignal ?? installSignalShutdown(log);
	await Promise.race([externalShutdown, daemonSettled]);

	log.log("[merge-worker] shutting down");
	await daemon.close().catch((err) => log.warn("daemon close error:", err));
	await pool.end().catch((err) => log.warn("pool end error:", err));
	if (daemonError !== undefined) throw daemonError;
}

function installSignalShutdown(
	log: Pick<Console, "log" | "warn" | "error">,
): Promise<void> {
	return new Promise<void>((resolveShutdown) => {
		let triggered = false;
		const handler = (signal: NodeJS.Signals) => {
			if (triggered) return;
			triggered = true;
			log.log(`[merge-worker] received ${signal}`);
			resolveShutdown();
		};
		process.once("SIGINT", handler);
		process.once("SIGTERM", handler);
	});
}

function reportError(err: unknown): void {
	const e = err as { code?: string; message?: string; stack?: string } | undefined;
	console.error("bs-merge-worker failed:");
	if (e?.code === "ECONNREFUSED") {
		console.error(
			"  Connection refused — is your postgres server running and reachable?",
		);
		return;
	}
	if (e?.message && e.message.trim() !== "") {
		console.error(`  ${e.message}`);
		return;
	}
	console.error(e?.stack ?? err);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();
	try {
		await runMergeWorker({
			projectRoot,
			flagDatabaseUrl: args.databaseUrl,
			flagAgentId: args.agentId,
			once: args.once,
		});
	} catch (err) {
		if (err instanceof MainIsRedError) {
			console.error(
				"[merge-worker] main is failing tests — fix main and restart bs-merge-worker",
			);
			console.error(err.output);
			process.exit(2);
		}
		if (err instanceof MergeFailedError) {
			console.error(
				"[merge-worker] merge repair failed — inspect staging worktree and restart bs-merge-worker",
			);
			process.exit(1);
		}
		throw err;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		reportError(err);
		process.exit(1);
	});
}

// Internal exports used by tests.
export { defaultVerifyStagingWorktree };
