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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getPool,
	issueCreate,
} from "../agent/extensions/bogstandard/db.js";
import {
	persistMergeHandoffWith,
	refNameForIssue,
} from "../agent/extensions/bogstandard/merge-handoff.js";
import { isPostgresAvailable, useTempDb } from "./helpers/temp-db.js";
import { truncateAll } from "./helpers/truncate.js";

const pi = {} as ExtensionAPI;

describe.skipIf(!isPostgresAvailable())("merge handoff transaction", () => {
	useTempDb();

	beforeEach(async () => {
		await truncateAll();
	});

	it("persists the phase, branch row, and exactly one idempotent merge task", async () => {
		const issueId = await issueCreate(pi, {
			title: "handoff",
			priority: "medium",
			phase: "implementing",
			needs_tests: false,
		});
		const refName = refNameForIssue(issueId);
		const args = {
			issueId,
			fromPhase: "implementing" as const,
			agentId: "worker-1",
			refName,
			headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		};

		await persistMergeHandoffWith(getPool(), args);
		await persistMergeHandoffWith(getPool(), args);

		const issue = await getPool().query<{ phase: string }>(
			`SELECT phase FROM issues WHERE id = $1`,
			[issueId],
		);
		expect(issue.rows[0].phase).toBe("merging_pending");

		const branch = await getPool().query<{
			ref_name: string;
			head_sha: string;
			base_sha: string;
		}>(
			`SELECT ref_name, head_sha, base_sha
			   FROM issue_branches
			  WHERE issue_id = $1`,
			[issueId],
		);
		expect(branch.rows).toEqual([
			{
				ref_name: refName,
				head_sha: args.headSha,
				base_sha: args.baseSha,
			},
		]);

		const tasks = await getPool().query<{
			state: string;
			params: { issueId: number };
			idempotency_key: string;
		}>(
			`SELECT state, params, idempotency_key
			   FROM merge_tasks
			  WHERE idempotency_key = $1`,
			[`merge:${issueId}`],
		);
		expect(tasks.rows).toEqual([
			{
				state: "pending",
				params: { issueId },
				idempotency_key: `merge:${issueId}`,
			},
		]);

		const events = await getPool().query<{ n: string }>(
			`SELECT count(*)::text AS n
			   FROM phase_events
			  WHERE issue_id = $1
			    AND phase_to = 'merging_pending'`,
			[issueId],
		);
		expect(events.rows[0].n).toBe("1");
	});
});
