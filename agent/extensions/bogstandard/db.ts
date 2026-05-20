/**
 * Postgres-backed issue store.
 *
 * One module-level `pg.Pool` is created lazily on the first query. Callers
 * must invoke `configureDb(config)` once before any DB function runs;
 * the extension does this from `session_start`, and the scripts call it from
 * their entry points. `pi` is accepted by every wrapper but not currently
 * used — it's kept as a parameter so we have a path to wiring cancel signals
 * later if pg gains AbortSignal support.
 */

import pg from "pg";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.js";

const { Pool } = pg;

let activeConfig: ResolvedConfig | undefined;
let pool: pg.Pool | undefined;

/** Inject the resolved config. Idempotent: subsequent calls replace state. */
export function configureDb(config: ResolvedConfig): void {
	if (pool && activeConfig?.databaseUrl !== config.databaseUrl) {
		// URL changed — close the old pool. Failure here is non-fatal.
		void pool.end().catch(() => {});
		pool = undefined;
	}
	activeConfig = config;
}

/** Test seam: reset module state between tests. */
export async function resetDbForTests(): Promise<void> {
	if (pool) {
		await pool.end().catch(() => {});
		pool = undefined;
	}
	activeConfig = undefined;
}

function requireConfig(): ResolvedConfig {
	if (!activeConfig) {
		throw new Error("BogStandard DB is not configured. Call configureDb(...) first.");
	}
	return activeConfig;
}

export function getPool(): pg.Pool {
	if (!pool) {
		const cfg = requireConfig();
		pool = new Pool({ connectionString: cfg.databaseUrl });
	}
	return pool;
}

export type CommentKind =
	| "note"
	| "plan"
	| "decision"
	| "observation"
	| "blocker"
	| "resolution"
	| "result"
	| "handoff"
	| "human";

export interface IssueListEntry {
	id: number;
	title: string;
	status: string;
	priority?: string;
}

export interface IssueComment {
	kind: string;
	content: string;
}

export interface Subissue {
	id: number;
	status: string;
}

export interface IssueDetail {
	id: number;
	title: string;
	status: string;
	priority?: string;
	description?: string | null;
	comments?: IssueComment[];
	subissues?: Subissue[];
	blocked_by?: number[];
}

export async function issueList(
	_pi: ExtensionAPI,
	_signal?: AbortSignal,
): Promise<IssueListEntry[]> {
	const result = await getPool().query<{
		id: string;
		title: string;
		status: string;
		priority: string;
	}>(
		`SELECT id, title, status, priority
		   FROM issues
		   ORDER BY id`,
	);
	return result.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		status: r.status,
		priority: r.priority,
	}));
}

export async function issueShowJson(
	_pi: ExtensionAPI,
	id: number,
	_signal?: AbortSignal,
): Promise<IssueDetail> {
	const p = getPool();
	const issueRes = await p.query<{
		id: string;
		title: string;
		description: string | null;
		status: string;
		priority: string;
	}>(
		`SELECT id, title, description, status, priority
		   FROM issues
		   WHERE id = $1`,
		[id],
	);
	if (issueRes.rowCount === 0) {
		throw new Error(`Issue ${id} not found`);
	}
	const row = issueRes.rows[0];

	const commentsRes = await p.query<{ kind: string; content: string }>(
		`SELECT kind, content
		   FROM comments
		   WHERE issue_id = $1
		   ORDER BY created_at, id`,
		[id],
	);

	const subissuesRes = await p.query<{ id: string; status: string }>(
		`SELECT id, status
		   FROM issues
		   WHERE parent_id = $1
		   ORDER BY id`,
		[id],
	);

	const blockersRes = await p.query<{ blocker_id: string }>(
		`SELECT blocker_id
		   FROM dependencies
		   WHERE blocked_id = $1
		   ORDER BY blocker_id`,
		[id],
	);

	return {
		id: Number(row.id),
		title: row.title,
		status: row.status,
		priority: row.priority,
		description: row.description,
		comments: commentsRes.rows.map((c) => ({ kind: c.kind, content: c.content })),
		subissues: subissuesRes.rows.map((s) => ({ id: Number(s.id), status: s.status })),
		blocked_by: blockersRes.rows.map((b) => Number(b.blocker_id)),
	};
}

/** Plain-text rendering kept for callers that previously used `issue show`. */
export async function issueShowText(
	pi: ExtensionAPI,
	id: number,
	signal?: AbortSignal,
): Promise<string> {
	const detail = await issueShowJson(pi, id, signal);
	return buildIssueDisplay(detail);
}

export async function issueComment(
	_pi: ExtensionAPI,
	id: number,
	kind: CommentKind,
	body: string,
	_signal?: AbortSignal,
): Promise<void> {
	await getPool().query(
		`INSERT INTO comments (issue_id, kind, content) VALUES ($1, $2, $3)`,
		[id, kind, body],
	);
}

export async function issueClose(
	_pi: ExtensionAPI,
	id: number,
	_signal?: AbortSignal,
): Promise<void> {
	const result = await getPool().query(
		`UPDATE issues
		    SET status = 'closed',
		        closed_at = now(),
		        updated_at = now()
		  WHERE id = $1`,
		[id],
	);
	if (result.rowCount === 0) {
		throw new Error(`Issue ${id} not found`);
	}
}

// ── Designer writes ─────────────────────────────────────────────────────────

export type Priority = "low" | "medium" | "high" | "critical";

const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "critical"];

export function assertPriority(p: string): asserts p is Priority {
	if (!(PRIORITIES as readonly string[]).includes(p)) {
		throw new Error(
			`Invalid priority '${p}'. Must be one of: ${PRIORITIES.join(", ")}`,
		);
	}
}

export interface IssueCreateInput {
	title: string;
	description?: string;
	priority: string;
	parent_id?: number;
}

/** Insert a new open issue. Returns the new id. */
export async function issueCreate(
	_pi: ExtensionAPI,
	input: IssueCreateInput,
): Promise<number> {
	assertPriority(input.priority);
	if (!input.title.trim()) {
		throw new Error("Issue title must not be empty");
	}
	const res = await getPool().query<{ id: string }>(
		`INSERT INTO issues (title, description, priority, parent_id)
		      VALUES ($1, $2, $3, $4)
		   RETURNING id`,
		[input.title, input.description ?? null, input.priority, input.parent_id ?? null],
	);
	return Number(res.rows[0].id);
}

export interface IssueUpdateInput {
	title?: string;
	description?: string;
	priority?: string;
}

/** Partial UPDATE; no-op if every field is undefined. */
export async function issueUpdate(
	_pi: ExtensionAPI,
	id: number,
	input: IssueUpdateInput,
): Promise<void> {
	const sets: string[] = [];
	const params: unknown[] = [];
	if (input.title !== undefined) {
		if (!input.title.trim()) throw new Error("Issue title must not be empty");
		params.push(input.title);
		sets.push(`title = $${params.length}`);
	}
	if (input.description !== undefined) {
		params.push(input.description);
		sets.push(`description = $${params.length}`);
	}
	if (input.priority !== undefined) {
		assertPriority(input.priority);
		params.push(input.priority);
		sets.push(`priority = $${params.length}`);
	}
	if (sets.length === 0) return;
	params.push(id);
	const result = await getPool().query(
		`UPDATE issues SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
		params,
	);
	if (result.rowCount === 0) throw new Error(`Issue ${id} not found`);
}

/** Set or clear an issue's parent_id. Null promotes a subissue to top-level. */
export async function issueSetParent(
	_pi: ExtensionAPI,
	id: number,
	parentId: number | null,
): Promise<void> {
	if (parentId !== null && parentId === id) {
		throw new Error("An issue cannot be its own parent");
	}
	const result = await getPool().query(
		`UPDATE issues SET parent_id = $1, updated_at = now() WHERE id = $2`,
		[parentId, id],
	);
	if (result.rowCount === 0) throw new Error(`Issue ${id} not found`);
}

/** Soft-delete: mark the issue as archived. */
export async function issueArchive(
	_pi: ExtensionAPI,
	id: number,
): Promise<void> {
	const result = await getPool().query(
		`UPDATE issues SET status = 'archived', updated_at = now() WHERE id = $1`,
		[id],
	);
	if (result.rowCount === 0) throw new Error(`Issue ${id} not found`);
}

export async function dependencyAdd(
	_pi: ExtensionAPI,
	blockedId: number,
	blockerId: number,
): Promise<void> {
	if (blockedId === blockerId) {
		throw new Error("An issue cannot block itself");
	}
	try {
		await getPool().query(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES ($1, $2)`,
			[blockerId, blockedId],
		);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "23505") {
			throw new Error(`Issue ${blockedId} is already blocked by issue ${blockerId}`);
		}
		if (code === "23503") {
			throw new Error(`Either issue ${blockedId} or ${blockerId} does not exist`);
		}
		throw err;
	}
}

export async function dependencyRemove(
	_pi: ExtensionAPI,
	blockedId: number,
	blockerId: number,
): Promise<void> {
	const result = await getPool().query(
		`DELETE FROM dependencies WHERE blocker_id = $1 AND blocked_id = $2`,
		[blockerId, blockedId],
	);
	if (result.rowCount === 0) {
		throw new Error(`No block relationship from ${blockerId} to ${blockedId}`);
	}
}

export interface IssueListFilter {
	status?: string;
	priority?: string;
	parent_id?: number | null;
}

/** List issues with optional filters. Used by the Designer's `list_issues` tool. */
export async function issueListFiltered(
	_pi: ExtensionAPI,
	filter: IssueListFilter = {},
): Promise<Array<IssueListEntry & { parent_id: number | null }>> {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (filter.status !== undefined) {
		params.push(filter.status);
		clauses.push(`status = $${params.length}`);
	}
	if (filter.priority !== undefined) {
		params.push(filter.priority);
		clauses.push(`priority = $${params.length}`);
	}
	if (filter.parent_id !== undefined) {
		if (filter.parent_id === null) {
			clauses.push(`parent_id IS NULL`);
		} else {
			params.push(filter.parent_id);
			clauses.push(`parent_id = $${params.length}`);
		}
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const res = await getPool().query<{
		id: string;
		title: string;
		status: string;
		priority: string;
		parent_id: string | null;
	}>(
		`SELECT id, title, status, priority, parent_id
		   FROM issues
		   ${where}
		   ORDER BY id`,
		params,
	);
	return res.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		status: r.status,
		priority: r.priority,
		parent_id: r.parent_id === null ? null : Number(r.parent_id),
	}));
}

// ── Locks ────────────────────────────────────────────────────────────────────

export interface LockEntry {
	agent_id: string;
	branch: string | null;
	claimed_at: string;
	signed_by: string;
}

export interface LocksFile {
	version: number;
	locks: Record<string, LockEntry>;
	settings: { stale_lock_timeout_minutes: number };
}

export async function locksList(_pi: ExtensionAPI): Promise<LocksFile | null> {
	try {
		const res = await getPool().query<{
			issue_id: string;
			agent_id: string;
			branch: string | null;
			claimed_at: Date;
		}>(
			`SELECT issue_id, agent_id, branch, claimed_at FROM locks ORDER BY issue_id`,
		);
		const locks: Record<string, LockEntry> = {};
		for (const row of res.rows) {
			locks[row.issue_id] = {
				agent_id: row.agent_id,
				branch: row.branch,
				claimed_at: row.claimed_at.toISOString(),
				signed_by: row.agent_id,
			};
		}
		return {
			version: 1,
			locks,
			settings: { stale_lock_timeout_minutes: requireConfig().staleLockTimeoutMinutes },
		};
	} catch {
		return null;
	}
}

/** Returns the configured agent id. Null only if config has not been set up. */
export async function getAgentId(_pi: ExtensionAPI): Promise<string | null> {
	try {
		return requireConfig().agentId;
	} catch {
		return null;
	}
}

export function isLockStale(entry: LockEntry, timeoutMinutes: number): boolean {
	const ageMs = Date.now() - new Date(entry.claimed_at).getTime();
	return ageMs > timeoutMinutes * 60 * 1000;
}

/** Claim a lock; throws if a different agent already holds it. */
export async function locksClaim(
	_pi: ExtensionAPI,
	issueId: number,
	branch?: string,
): Promise<void> {
	const cfg = requireConfig();
	const result = await getPool().query<{ agent_id: string }>(
		`INSERT INTO locks (issue_id, agent_id, branch)
		      VALUES ($1, $2, $3)
		 ON CONFLICT (issue_id) DO NOTHING
		   RETURNING agent_id`,
		[issueId, cfg.agentId, branch ?? null],
	);
	if (result.rowCount && result.rowCount > 0) return; // freshly claimed

	const existing = await getPool().query<{ agent_id: string }>(
		`SELECT agent_id FROM locks WHERE issue_id = $1`,
		[issueId],
	);
	const holder = existing.rows[0]?.agent_id;
	if (holder === cfg.agentId) return; // we already hold it
	throw new Error(`Issue ${issueId} is locked by '${holder ?? "unknown"}'`);
}

/** Release a lock we own. Silent no-op if we don't hold it. */
export async function locksRelease(
	_pi: ExtensionAPI,
	issueId: number,
): Promise<void> {
	try {
		const cfg = requireConfig();
		await getPool().query(
			`DELETE FROM locks WHERE issue_id = $1 AND agent_id = $2`,
			[issueId, cfg.agentId],
		);
	} catch {
		// best-effort: lock release never blocks the workflow
	}
}

/** Force-claim a lock held by another agent. */
export async function locksSteal(
	_pi: ExtensionAPI,
	issueId: number,
): Promise<void> {
	const cfg = requireConfig();
	await getPool().query(
		`INSERT INTO locks (issue_id, agent_id, branch, claimed_at)
		      VALUES ($1, $2, NULL, now())
		 ON CONFLICT (issue_id) DO UPDATE
		       SET agent_id   = EXCLUDED.agent_id,
		           branch     = EXCLUDED.branch,
		           claimed_at = EXCLUDED.claimed_at`,
		[issueId, cfg.agentId],
	);
}

// ── Issue display ───────────────────────────────────────────────────────────

export function buildIssueDisplay(issue: IssueDetail): string {
	const parts: string[] = [];
	if (issue.description && issue.description.trim() !== "") {
		parts.push(issue.description);
	}
	for (const comment of issue.comments ?? []) {
		parts.push(`# Comment (${comment.kind})\n\n${comment.content}`);
	}
	return parts.join("\n\n");
}
