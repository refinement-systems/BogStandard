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
 * Shared truncate helper for integration tests. Wipes all rows from the
 * application tables (preserving schema) and resets sequences so each test
 * starts from id 1. The CASCADE handles FKs in any order.
 *
 * Includes `agent_config` because schema-constraints tests insert into it.
 */

import { getPool } from "../../agent/extensions/bogstandard/db.js";

export async function truncateAll(): Promise<void> {
	await getPool().query(
		`TRUNCATE phase_events, comments, dependencies, issue_versions, issues, agent_config RESTART IDENTITY CASCADE`,
	);
}
