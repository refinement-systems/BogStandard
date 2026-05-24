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
 * Postgres-backed issue store.
 *
 * The schema is issue-centric: each row in `issues` carries its own phase,
 * current owner, and pointer to the active row in `issue_versions`. Comments
 * are scoped to one version; the `phase_events` table is the append-only
 * audit log that replaces both pi.appendEntry and the previous comment-
 * embedded event markers.
 */

import pg from "pg";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.js";

const { Pool } = pg;

let activeConfig: ResolvedConfig | undefined;
let pool: pg.Pool | undefined;

export function configureDb(config: ResolvedConfig): void {
	if (pool && activeConfig?.databaseUrl !== config.databaseUrl) {
		void pool.end().catch(() => {});
		pool = undefined;
	}
	activeConfig = config;
}

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

// ── Types ────────────────────────────────────────────────────────────────────

export type Phase =
	| "drafting"
	| "ready"
	| "planning"
	| "implementing"
	| "red_planning"
	| "red_impl"
	| "green_planning"
	| "green_impl"
	| "done"
	| "aborted"
	| "archived";

export const ALL_PHASES: readonly Phase[] = [
	"drafting",
	"ready",
	"planning",
	"implementing",
	"red_planning",
	"red_impl",
	"green_planning",
	"green_impl",
	"done",
	"aborted",
	"archived",
];

/** Phases that mean an agent is actively working the issue. */
export function isWorkingPhase(phase: Phase): boolean {
	return (
		phase === "planning" ||
		phase === "implementing" ||
		phase === "red_planning" ||
		phase === "red_impl" ||
		phase === "green_planning" ||
		phase === "green_impl"
	);
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
	| "human"
	| "carry_forward";

export interface IssueListEntry {
	id: number;
	title: string;
	phase: Phase;
	priority?: string;
	/** Convenience alias for `phase`, kept so legacy display code keeps working. */
	status?: string;
}

export interface IssueComment {
	kind: string;
	content: string;
}

export interface Subissue {
	id: number;
	phase: Phase;
}

export interface IssueVersionSummary {
	id: number;
	version_no: number;
	title: string;
	description: string | null;
	needs_tests: boolean | null;
	created_at: string;
	created_by: string | null;
}

/**
 * Current view of an issue, with the active version flattened onto the top
 * level for caller convenience. `current_version_no` and `current_version_id`
 * disambiguate when callers need to address the version explicitly.
 */
export interface IssueDetail {
	id: number;
	title: string;
	phase: Phase;
	priority?: string;
	description?: string | null;
	needs_tests?: boolean | null;
	current_version_id: number;
	current_version_no: number;
	current_agent_id?: string | null;
	phase_started_at?: string | null;
	comments?: IssueComment[];
	subissues?: Subissue[];
	blocked_by?: number[];
	/** Populated only when explicitly requested (e.g. Designer redraft view). */
	history?: Array<IssueVersionSummary & { comments: IssueComment[] }>;
}

export interface PhaseEvent {
	id: number;
	issue_id: number;
	version_id: number | null;
	phase_from: Phase | null;
	phase_to: Phase;
	agent_id: string | null;
	reason: string | null;
	metadata: Record<string, unknown> | null;
	created_at: string;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function issueList(_pi: ExtensionAPI): Promise<IssueListEntry[]> {
	const result = await getPool().query<{
		id: string;
		title: string;
		phase: Phase;
		priority: string;
	}>(
		`SELECT i.id, v.title, i.phase, i.priority
		   FROM issues i
		   JOIN issue_versions v ON v.id = i.current_version_id
		   ORDER BY i.id`,
	);
	return result.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		phase: r.phase,
		priority: r.priority,
		status: r.phase,
	}));
}

export async function issueShowJson(
	_pi: ExtensionAPI,
	id: number,
	opts: { include_history?: boolean } = {},
): Promise<IssueDetail> {
	const p = getPool();
	const issueRes = await p.query<{
		id: string;
		phase: Phase;
		priority: string;
		current_version_id: string;
		current_agent_id: string | null;
		phase_started_at: Date | null;
		version_no: number;
		title: string;
		description: string | null;
		needs_tests: boolean | null;
	}>(
		`SELECT i.id,
		        i.phase,
		        i.priority,
		        i.current_version_id,
		        i.current_agent_id,
		        i.phase_started_at,
		        v.version_no,
		        v.title,
		        v.description,
		        v.needs_tests
		   FROM issues i
		   JOIN issue_versions v ON v.id = i.current_version_id
		  WHERE i.id = $1`,
		[id],
	);
	if (issueRes.rowCount === 0) {
		throw new Error(`Issue ${id} not found`);
	}
	const row = issueRes.rows[0];

	const commentsRes = await p.query<{ kind: string; content: string }>(
		`SELECT kind, content
		   FROM comments
		  WHERE version_id = $1
		  ORDER BY created_at, id`,
		[row.current_version_id],
	);

	const subissuesRes = await p.query<{ id: string; phase: Phase }>(
		`SELECT id, phase
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

	const detail: IssueDetail = {
		id: Number(row.id),
		title: row.title,
		phase: row.phase,
		priority: row.priority,
		description: row.description,
		needs_tests: row.needs_tests,
		current_version_id: Number(row.current_version_id),
		current_version_no: row.version_no,
		current_agent_id: row.current_agent_id,
		phase_started_at: row.phase_started_at ? row.phase_started_at.toISOString() : null,
		comments: commentsRes.rows.map((c) => ({ kind: c.kind, content: c.content })),
		subissues: subissuesRes.rows.map((s) => ({ id: Number(s.id), phase: s.phase })),
		blocked_by: blockersRes.rows.map((b) => Number(b.blocker_id)),
	};

	if (opts.include_history) {
		const versionsRes = await p.query<{
			id: string;
			version_no: number;
			title: string;
			description: string | null;
			needs_tests: boolean | null;
			created_at: Date;
			created_by: string | null;
		}>(
			`SELECT id, version_no, title, description, needs_tests, created_at, created_by
			   FROM issue_versions
			  WHERE issue_id = $1
			  ORDER BY version_no`,
			[id],
		);
		const allComments = await p.query<{
			version_id: string;
			kind: string;
			content: string;
		}>(
			`SELECT version_id, kind, content
			   FROM comments
			  WHERE issue_id = $1
			  ORDER BY created_at, id`,
			[id],
		);
		const byVersion = new Map<string, IssueComment[]>();
		for (const c of allComments.rows) {
			const arr = byVersion.get(c.version_id) ?? [];
			arr.push({ kind: c.kind, content: c.content });
			byVersion.set(c.version_id, arr);
		}
		detail.history = versionsRes.rows.map((v) => ({
			id: Number(v.id),
			version_no: v.version_no,
			title: v.title,
			description: v.description,
			needs_tests: v.needs_tests,
			created_at: v.created_at.toISOString(),
			created_by: v.created_by,
			comments: byVersion.get(v.id) ?? [],
		}));
	}

	return detail;
}

/** Plain-text rendering kept for callers that previously used `issue show`. */
export async function issueShowText(
	pi: ExtensionAPI,
	id: number,
): Promise<string> {
	const detail = await issueShowJson(pi, id);
	return buildIssueDisplay(detail);
}

export async function issueComment(
	_pi: ExtensionAPI,
	id: number,
	kind: CommentKind,
	body: string,
): Promise<void> {
	const p = getPool();
	const versionRes = await p.query<{ current_version_id: string }>(
		`SELECT current_version_id FROM issues WHERE id = $1`,
		[id],
	);
	if (versionRes.rowCount === 0) {
		throw new Error(`Issue ${id} not found`);
	}
	await p.query(
		`INSERT INTO comments (issue_id, version_id, kind, content) VALUES ($1, $2, $3, $4)`,
		[id, versionRes.rows[0].current_version_id, kind, body],
	);
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
	needs_tests?: boolean;
	/** Defaults to 'drafting'. Designer uses default; importers may pass others. */
	phase?: Phase;
	created_by?: string;
}

/**
 * Insert a new issue along with its v1 version, atomically. Returns the new
 * issue id.
 */
export async function issueCreate(
	_pi: ExtensionAPI,
	input: IssueCreateInput,
): Promise<number> {
	assertPriority(input.priority);
	if (!input.title.trim()) {
		throw new Error("Issue title must not be empty");
	}
	const phase: Phase = input.phase ?? "drafting";
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		const issueRes = await client.query<{ id: string }>(
			`INSERT INTO issues (priority, parent_id, phase)
			      VALUES ($1, $2, $3)
			   RETURNING id`,
			[input.priority, input.parent_id ?? null, phase],
		);
		const issueId = Number(issueRes.rows[0].id);
		const versionRes = await client.query<{ id: string }>(
			`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests, created_by)
			      VALUES ($1, 1, $2, $3, $4, $5)
			   RETURNING id`,
			[issueId, input.title, input.description ?? null, input.needs_tests ?? null, input.created_by ?? null],
		);
		const versionId = Number(versionRes.rows[0].id);
		await client.query(
			`UPDATE issues SET current_version_id = $1 WHERE id = $2`,
			[versionId, issueId],
		);
		await client.query("COMMIT");
		return issueId;
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

/**
 * Promote a `drafting` issue to `ready`. Requires `needs_tests` to be set on
 * the current version — the Designer is expected to classify before promotion.
 */
export async function issuePromoteToReady(
	_pi: ExtensionAPI,
	id: number,
	agentId: string | null,
): Promise<void> {
	const p = getPool();
	const cur = await p.query<{ phase: Phase; current_version_id: string; needs_tests: boolean | null }>(
		`SELECT i.phase, i.current_version_id, v.needs_tests
		   FROM issues i
		   JOIN issue_versions v ON v.id = i.current_version_id
		  WHERE i.id = $1`,
		[id],
	);
	if (cur.rowCount === 0) throw new Error(`Issue ${id} not found`);
	const row = cur.rows[0];
	if (row.phase !== "drafting") {
		throw new Error(`Issue ${id} is in phase '${row.phase}', cannot promote to ready (must be 'drafting')`);
	}
	if (row.needs_tests === null) {
		throw new Error(`Issue ${id} cannot be promoted: needs_tests is not set on the current version`);
	}
	const client = await p.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`UPDATE issues SET phase = 'ready', updated_at = now() WHERE id = $1 AND phase = 'drafting'`,
			[id],
		);
		await client.query(
			`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason)
			      VALUES ($1, $2, 'drafting', 'ready', $3, 'promoted by Designer')`,
			[id, row.current_version_id, agentId],
		);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

export interface IssueUpdateInput {
	title?: string;
	description?: string;
	priority?: string;
	needs_tests?: boolean;
}

/**
 * Update the current version's title/description/needs_tests in place, and
 * (separately) the issue row's priority. Only legal while the issue is in
 * `drafting` phase — once promoted, descriptions must change via redraft.
 */
export async function issueUpdate(
	_pi: ExtensionAPI,
	id: number,
	input: IssueUpdateInput,
): Promise<void> {
	const anyVersionField =
		input.title !== undefined ||
		input.description !== undefined ||
		input.needs_tests !== undefined;
	const anyIssueField = input.priority !== undefined;
	if (!anyVersionField && !anyIssueField) return;

	const p = getPool();
	const cur = await p.query<{ phase: Phase; current_version_id: string }>(
		`SELECT phase, current_version_id FROM issues WHERE id = $1`,
		[id],
	);
	if (cur.rowCount === 0) throw new Error(`Issue ${id} not found`);
	const { phase, current_version_id } = cur.rows[0];

	const client = await p.connect();
	try {
		await client.query("BEGIN");

		if (anyVersionField) {
			if (phase !== "drafting") {
				throw new Error(
					`Issue ${id} is in phase '${phase}': title/description/needs_tests can only be edited while drafting. Use redraft_issue to change them after promotion.`,
				);
			}
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
			if (input.needs_tests !== undefined) {
				params.push(input.needs_tests);
				sets.push(`needs_tests = $${params.length}`);
			}
			params.push(current_version_id);
			await client.query(
				`UPDATE issue_versions SET ${sets.join(", ")} WHERE id = $${params.length}`,
				params,
			);
		}

		if (anyIssueField) {
			assertPriority(input.priority as string);
			await client.query(
				`UPDATE issues SET priority = $1, updated_at = now() WHERE id = $2`,
				[input.priority, id],
			);
		} else if (anyVersionField) {
			await client.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [id]);
		}

		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

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

/** Soft-delete: move the issue into phase='archived'. */
export async function issueArchive(
	_pi: ExtensionAPI,
	id: number,
	agentId: string | null,
): Promise<void> {
	const p = getPool();
	const cur = await p.query<{ phase: Phase; current_version_id: string }>(
		`SELECT phase, current_version_id FROM issues WHERE id = $1`,
		[id],
	);
	if (cur.rowCount === 0) throw new Error(`Issue ${id} not found`);
	const { phase, current_version_id } = cur.rows[0];
	if (phase === "archived") return;
	const client = await p.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`UPDATE issues SET phase = 'archived', updated_at = now() WHERE id = $1`,
			[id],
		);
		await client.query(
			`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason)
			      VALUES ($1, $2, $3, 'archived', $4, 'archived')`,
			[id, current_version_id, phase, agentId],
		);
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

export interface RedraftInput {
	title: string;
	description: string;
	needs_tests: boolean;
	carry_forward_summary: string;
	created_by?: string;
}

/**
 * Create a new version, point current_version_id at it, reset phase to
 * 'ready', and insert a single carry_forward comment on the new version
 * containing the Designer's summary of what was kept from the prior version.
 *
 * Only allowed when phase ∈ {drafting, ready, aborted}.
 */
export async function redraftIssue(
	_pi: ExtensionAPI,
	id: number,
	input: RedraftInput,
	agentId: string | null,
): Promise<{ version_id: number; version_no: number }> {
	if (!input.title.trim()) throw new Error("Issue title must not be empty");
	if (!input.carry_forward_summary.trim()) {
		throw new Error("carry_forward_summary must not be empty");
	}

	const p = getPool();
	const cur = await p.query<{ phase: Phase }>(`SELECT phase FROM issues WHERE id = $1`, [id]);
	if (cur.rowCount === 0) throw new Error(`Issue ${id} not found`);
	const phaseFrom = cur.rows[0].phase;
	if (phaseFrom !== "drafting" && phaseFrom !== "ready" && phaseFrom !== "aborted") {
		throw new Error(
			`Issue ${id} is in phase '${phaseFrom}': redraft requires phase to be drafting, ready, or aborted`,
		);
	}

	const client = await p.connect();
	try {
		await client.query("BEGIN");
		const maxRes = await client.query<{ max: number | null }>(
			`SELECT MAX(version_no) AS max FROM issue_versions WHERE issue_id = $1`,
			[id],
		);
		const nextVersion = (maxRes.rows[0]?.max ?? 0) + 1;

		const versionRes = await client.query<{ id: string }>(
			`INSERT INTO issue_versions (issue_id, version_no, title, description, needs_tests, created_by)
			      VALUES ($1, $2, $3, $4, $5, $6)
			   RETURNING id`,
			[id, nextVersion, input.title, input.description, input.needs_tests, input.created_by ?? agentId],
		);
		const versionId = Number(versionRes.rows[0].id);

		await client.query(
			`UPDATE issues SET current_version_id = $1, phase = 'ready', updated_at = now() WHERE id = $2`,
			[versionId, id],
		);

		await client.query(
			`INSERT INTO comments (issue_id, version_id, kind, content)
			      VALUES ($1, $2, 'carry_forward', $3)`,
			[id, versionId, input.carry_forward_summary],
		);

		await client.query(
			`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata)
			      VALUES ($1, $2, $3, 'ready', $4, 'redraft', $5)`,
			[id, versionId, phaseFrom, agentId, JSON.stringify({ version_no: nextVersion })],
		);

		await client.query("COMMIT");
		return { version_id: versionId, version_no: nextVersion };
	} catch (err) {
		await client.query("ROLLBACK").catch(() => {});
		throw err;
	} finally {
		client.release();
	}
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
	phase?: Phase | Phase[];
	priority?: string;
	parent_id?: number | null;
}

/**
 * List issues with optional filters. Used by the Designer's `list_issues`
 * tool. Default filter: phases drafting + ready (the operator's active set).
 */
export async function issueListFiltered(
	_pi: ExtensionAPI,
	filter: IssueListFilter = {},
): Promise<Array<IssueListEntry & { parent_id: number | null }>> {
	const clauses: string[] = [];
	const params: unknown[] = [];

	if (filter.phase !== undefined) {
		const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
		const placeholders = phases.map((ph) => {
			params.push(ph);
			return `$${params.length}`;
		});
		clauses.push(`i.phase IN (${placeholders.join(", ")})`);
	} else {
		clauses.push(`i.phase IN ('drafting', 'ready')`);
	}
	if (filter.priority !== undefined) {
		params.push(filter.priority);
		clauses.push(`i.priority = $${params.length}`);
	}
	if (filter.parent_id !== undefined) {
		if (filter.parent_id === null) {
			clauses.push(`i.parent_id IS NULL`);
		} else {
			params.push(filter.parent_id);
			clauses.push(`i.parent_id = $${params.length}`);
		}
	}

	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const res = await getPool().query<{
		id: string;
		title: string;
		phase: Phase;
		priority: string;
		parent_id: string | null;
	}>(
		`SELECT i.id, v.title, i.phase, i.priority, i.parent_id
		   FROM issues i
		   JOIN issue_versions v ON v.id = i.current_version_id
		   ${where}
		   ORDER BY i.id`,
		params,
	);
	return res.rows.map((r) => ({
		id: Number(r.id),
		title: r.title,
		phase: r.phase,
		priority: r.priority,
		status: r.phase,
		parent_id: r.parent_id === null ? null : Number(r.parent_id),
	}));
}

// ── Phase machine ───────────────────────────────────────────────────────────

export interface PhaseTransitionInput {
	issueId: number;
	from?: Phase;
	to: Phase;
	agentId: string | null;
	reason?: string | null;
	metadata?: Record<string, unknown> | null;
	versionId?: number | null;
}

/**
 * Atomically transition an issue's phase and append a phase_events row.
 * If `from` is supplied, the UPDATE is gated so concurrent transitions
 * cannot race. Throws if the precondition fails.
 *
 * Side effect: sets phase_started_at to now() for the new phase.
 * Clears current_agent_id when transitioning into a non-working phase.
 */
export async function transitionPhase(
	_pi: ExtensionAPI,
	input: PhaseTransitionInput,
): Promise<void> {
	const p = getPool();
	const client = await p.connect();
	try {
		await client.query("BEGIN");

		let versionId = input.versionId;
		if (versionId === undefined) {
			const v = await client.query<{ current_version_id: string }>(
				`SELECT current_version_id FROM issues WHERE id = $1`,
				[input.issueId],
			);
			if (v.rowCount === 0) throw new Error(`Issue ${input.issueId} not found`);
			versionId = Number(v.rows[0].current_version_id);
		}

		const clearAgent = !isWorkingPhase(input.to);
		const params: unknown[] = [input.to, input.issueId];
		let predicate = "id = $2";
		if (input.from !== undefined) {
			params.push(input.from);
			predicate += ` AND phase = $${params.length}`;
		}
		const result = await client.query<{ id: string }>(
			`UPDATE issues
			    SET phase = $1,
			        phase_started_at = now(),
			        updated_at = now()
			        ${clearAgent ? ", current_agent_id = NULL" : ""}
			  WHERE ${predicate}
			  RETURNING id`,
			params,
		);
		if (result.rowCount === 0) {
			throw new Error(
				`Could not transition issue ${input.issueId} to '${input.to}' (precondition failed)`,
			);
		}

		await client.query(
			`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata)
			      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				input.issueId,
				versionId ?? null,
				input.from ?? null,
				input.to,
				input.agentId,
				input.reason ?? null,
				input.metadata ? JSON.stringify(input.metadata) : null,
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

/** Append a phase_events row without changing the issue's phase. */
export async function appendPhaseEvent(
	_pi: ExtensionAPI,
	input: {
		issueId: number;
		phase: Phase;
		agentId: string | null;
		reason?: string | null;
		metadata?: Record<string, unknown> | null;
		versionId?: number | null;
	},
): Promise<void> {
	const p = getPool();
	let versionId = input.versionId;
	if (versionId === undefined) {
		const v = await p.query<{ current_version_id: string }>(
			`SELECT current_version_id FROM issues WHERE id = $1`,
			[input.issueId],
		);
		if (v.rowCount === 0) throw new Error(`Issue ${input.issueId} not found`);
		versionId = Number(v.rows[0].current_version_id);
	}
	await p.query(
		`INSERT INTO phase_events (issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata)
		      VALUES ($1, $2, $3, $3, $4, $5, $6)`,
		[
			input.issueId,
			versionId ?? null,
			input.phase,
			input.agentId,
			input.reason ?? null,
			input.metadata ? JSON.stringify(input.metadata) : null,
		],
	);
}

export async function recentPhaseEvents(
	_pi: ExtensionAPI,
	issueId: number,
	limit = 10,
): Promise<PhaseEvent[]> {
	const res = await getPool().query<{
		id: string;
		issue_id: string;
		version_id: string | null;
		phase_from: Phase | null;
		phase_to: Phase;
		agent_id: string | null;
		reason: string | null;
		metadata: Record<string, unknown> | null;
		created_at: Date;
	}>(
		`SELECT id, issue_id, version_id, phase_from, phase_to, agent_id, reason, metadata, created_at
		   FROM phase_events
		  WHERE issue_id = $1
		  ORDER BY id DESC
		  LIMIT $2`,
		[issueId, limit],
	);
	return res.rows.map((r) => ({
		id: Number(r.id),
		issue_id: Number(r.issue_id),
		version_id: r.version_id === null ? null : Number(r.version_id),
		phase_from: r.phase_from,
		phase_to: r.phase_to,
		agent_id: r.agent_id,
		reason: r.reason,
		metadata: r.metadata,
		created_at: r.created_at.toISOString(),
	}));
}

// ── Ownership (collapsed lock) ──────────────────────────────────────────────

export interface IssueOwnership {
	current_agent_id: string | null;
	phase_started_at: string | null;
	phase: Phase;
}

export async function getOwnership(
	_pi: ExtensionAPI,
	issueId: number,
): Promise<IssueOwnership | null> {
	const res = await getPool().query<{
		current_agent_id: string | null;
		phase_started_at: Date | null;
		phase: Phase;
	}>(
		`SELECT current_agent_id, phase_started_at, phase FROM issues WHERE id = $1`,
		[issueId],
	);
	if (res.rowCount === 0) return null;
	const r = res.rows[0];
	return {
		current_agent_id: r.current_agent_id,
		phase_started_at: r.phase_started_at ? r.phase_started_at.toISOString() : null,
		phase: r.phase,
	};
}

/**
 * Conditional UPDATE: claim the issue for `agentId` only if it is unowned or
 * its heartbeat has gone stale. Returns true on successful claim.
 */
export async function claimIssue(
	_pi: ExtensionAPI,
	issueId: number,
	agentId: string,
	staleMinutes: number,
): Promise<boolean> {
	const res = await getPool().query<{ id: string }>(
		`UPDATE issues
		    SET current_agent_id = $1,
		        phase_started_at = now()
		  WHERE id = $2
		    AND (current_agent_id IS NULL
		         OR current_agent_id = $1
		         OR phase_started_at < now() - ($3::int || ' minutes')::interval)
		  RETURNING id`,
		[agentId, issueId, staleMinutes],
	);
	return (res.rowCount ?? 0) > 0;
}

/** Release a claim we own. Silent no-op otherwise. */
export async function releaseIssue(
	_pi: ExtensionAPI,
	issueId: number,
	agentId: string,
): Promise<void> {
	try {
		await getPool().query(
			`UPDATE issues SET current_agent_id = NULL WHERE id = $1 AND current_agent_id = $2`,
			[issueId, agentId],
		);
	} catch {
		// best-effort: release never blocks the workflow
	}
}

/** Force-claim an issue regardless of who currently holds it. */
export async function stealIssue(
	_pi: ExtensionAPI,
	issueId: number,
	agentId: string,
): Promise<void> {
	await getPool().query(
		`UPDATE issues
		    SET current_agent_id = $1,
		        phase_started_at = now()
		  WHERE id = $2`,
		[agentId, issueId],
	);
}

/** Heartbeat: bump phase_started_at while keeping the same phase + owner. */
export async function touchOwnership(
	_pi: ExtensionAPI,
	issueId: number,
	agentId: string,
): Promise<void> {
	await getPool().query(
		`UPDATE issues SET phase_started_at = now() WHERE id = $1 AND current_agent_id = $2`,
		[issueId, agentId],
	);
}

export function isPhaseStale(phaseStartedAt: string | null, timeoutMinutes: number): boolean {
	if (!phaseStartedAt) return false;
	const ageMs = Date.now() - new Date(phaseStartedAt).getTime();
	return ageMs > timeoutMinutes * 60 * 1000;
}

/** Returns the configured agent id. Null only if config has not been set up. */
export async function getAgentId(_pi: ExtensionAPI): Promise<string | null> {
	try {
		return requireConfig().agentId;
	} catch {
		return null;
	}
}

/** Returns the configured stale-lock timeout in minutes. Defaults to 60 when config isn't loaded. */
export function getStaleTimeoutMinutes(): number {
	try {
		return requireConfig().staleLockTimeoutMinutes;
	} catch {
		return 60;
	}
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
