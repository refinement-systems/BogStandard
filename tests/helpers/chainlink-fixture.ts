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
 * Build a temp SQLite database that mirrors the chainlink-era schema, used
 * to drive `scripts/import-from-chainlink.ts` tests end-to-end.
 *
 * The schema reproduced here is the minimum the importer reads:
 *   issues(id, title, description, status, priority, parent_id, created_at, updated_at, closed_at)
 *   comments(id, issue_id, content, created_at, kind)
 *   dependencies(blocker_id, blocked_id)
 *
 * `agent.json` is written alongside as a separate file path returned in the
 * handle. The caller cleans up via `dispose()` (registered automatically by
 * `makeChainlinkFixture` in `afterAll`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface ChainlinkIssueInput {
	id: number;
	title: string;
	description?: string | null;
	status?: "open" | "draft" | "closed" | "archived" | string;
	priority?: "low" | "medium" | "high" | "critical";
	parent_id?: number | null;
	created_at?: string;
	updated_at?: string;
	closed_at?: string | null;
}

export interface ChainlinkCommentInput {
	id: number;
	issue_id: number;
	content: string;
	created_at?: string;
	kind?: string | null;
}

export interface ChainlinkDepInput {
	blocker_id: number;
	blocked_id: number;
}

export interface ChainlinkFixtureSpec {
	issues?: ChainlinkIssueInput[];
	comments?: ChainlinkCommentInput[];
	dependencies?: ChainlinkDepInput[];
	agent?: { agent_id?: string; description?: string } | null;
}

export interface ChainlinkFixtureHandle {
	/** Absolute path to the temp .chainlink/issues.db file. */
	dbPath: string;
	/** Absolute path to the temp .chainlink/agent.json file (always exists; contents depend on spec.agent). */
	agentJsonPath: string;
	/** The temp directory that contains both. Useful for `--source` flag tests. */
	dir: string;
	/** Remove the temp tree. Idempotent. */
	dispose: () => void;
}

const ISO_2024 = "2024-01-01T00:00:00Z";

export function makeChainlinkFixture(spec: ChainlinkFixtureSpec = {}): ChainlinkFixtureHandle {
	const dir = mkdtempSync(join(tmpdir(), "bs-chainlink-"));
	const dbPath = join(dir, "issues.db");
	const agentJsonPath = join(dir, "agent.json");

	const db = new Database(dbPath);
	try {
		db.exec(`
			CREATE TABLE issues (
				id          INTEGER PRIMARY KEY,
				title       TEXT NOT NULL,
				description TEXT,
				status      TEXT NOT NULL DEFAULT 'open',
				priority    TEXT NOT NULL DEFAULT 'medium',
				parent_id   INTEGER,
				created_at  TEXT NOT NULL DEFAULT '${ISO_2024}',
				updated_at  TEXT NOT NULL DEFAULT '${ISO_2024}',
				closed_at   TEXT
			);
			CREATE TABLE comments (
				id         INTEGER PRIMARY KEY,
				issue_id   INTEGER NOT NULL,
				content    TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT '${ISO_2024}',
				kind       TEXT
			);
			CREATE TABLE dependencies (
				blocker_id INTEGER NOT NULL,
				blocked_id INTEGER NOT NULL,
				PRIMARY KEY (blocker_id, blocked_id)
			);
		`);

		const insIssue = db.prepare(
			`INSERT INTO issues (id, title, description, status, priority, parent_id, created_at, updated_at, closed_at)
			      VALUES (@id, @title, @description, @status, @priority, @parent_id, @created_at, @updated_at, @closed_at)`,
		);
		for (const i of spec.issues ?? []) {
			insIssue.run({
				id: i.id,
				title: i.title,
				description: i.description ?? null,
				status: i.status ?? "open",
				priority: i.priority ?? "medium",
				parent_id: i.parent_id ?? null,
				created_at: i.created_at ?? ISO_2024,
				updated_at: i.updated_at ?? ISO_2024,
				closed_at: i.closed_at ?? null,
			});
		}

		const insComment = db.prepare(
			`INSERT INTO comments (id, issue_id, content, created_at, kind)
			      VALUES (@id, @issue_id, @content, @created_at, @kind)`,
		);
		for (const c of spec.comments ?? []) {
			insComment.run({
				id: c.id,
				issue_id: c.issue_id,
				content: c.content,
				created_at: c.created_at ?? ISO_2024,
				kind: c.kind ?? null,
			});
		}

		const insDep = db.prepare(
			`INSERT INTO dependencies (blocker_id, blocked_id) VALUES (@blocker_id, @blocked_id)`,
		);
		for (const d of spec.dependencies ?? []) {
			insDep.run({ blocker_id: d.blocker_id, blocked_id: d.blocked_id });
		}
	} finally {
		db.close();
	}

	// agent.json: write only if explicitly requested. The importer treats a
	// missing file as a skip-with-message, which is exactly what tests for the
	// missing-file branch want to observe; for that case the helper still
	// returns the *intended* path even though no file exists at it.
	if (spec.agent === undefined) {
		writeFileSync(agentJsonPath, JSON.stringify({ agent_id: "imported-agent" }) + "\n");
	} else if (spec.agent === null) {
		// Caller wants no agent.json — leave the path unwritten.
	} else {
		writeFileSync(agentJsonPath, JSON.stringify(spec.agent) + "\n");
	}

	return {
		dbPath,
		agentJsonPath,
		dir,
		dispose: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
	};
}

/**
 * Write an arbitrary string at `agent.json`. Used by tests that want to
 * exercise the malformed-JSON branch in `migrateAgentJson`.
 */
export function writeAgentJsonRaw(dir: string, content: string): string {
	const path = join(dir, "agent.json");
	writeFileSync(path, content);
	return path;
}
