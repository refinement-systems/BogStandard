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
 * Print eligible issue ids (one per line) for dispatch.sh.
 *
 *   npm run -s list-eligible -- [--limit N]
 *
 * Same eligibility rule as the extension's auto-picker. Reuses the
 * configured postgres connection (.bogstandard/config.json + env + flag).
 */

import pg from "pg";
import { loadConfig } from "../agent/extensions/bogstandard/config.js";
import { ELIGIBLE_SQL } from "../agent/extensions/bogstandard/issue-picker.js";

const { Client } = pg;

function parseLimit(argv: string[]): number | undefined {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--limit") {
			const v = argv[i + 1];
			if (v === undefined) throw new Error("Missing value for --limit");
			const n = Number.parseInt(v, 10);
			if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --limit value: ${v}`);
			return n;
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	const projectRoot = process.env.BS_PROJECT_ROOT ?? process.cwd();
	const cfg = loadConfig({ projectRoot });
	const limit = parseLimit(process.argv.slice(2));

	const client = new Client({ connectionString: cfg.databaseUrl });
	await client.connect();
	try {
		const res = await client.query<{ id: string }>(ELIGIBLE_SQL);
		const ids = res.rows.map((r) => Number(r.id));
		const out = limit === undefined ? ids : ids.slice(0, limit);
		for (const id of out) console.log(id);
	} finally {
		await client.end();
	}
}

main().catch((err) => {
	const e = err as { code?: string; message?: string; stack?: string } | undefined;
	if (e?.code === "ECONNREFUSED") {
		console.error("bs-list-eligible: connection refused — is postgres running?");
	} else if (e?.message && e.message.trim() !== "") {
		console.error(`bs-list-eligible: ${e.message}`);
	} else {
		console.error(e?.stack ?? err);
	}
	process.exit(1);
});
