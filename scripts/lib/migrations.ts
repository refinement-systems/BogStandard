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
 * Shared node-pg-migrate runner used by both scripts/setup.ts (first-time
 * setup) and scripts/migrate.ts (apply pending migrations against an
 * existing database).
 */

import { runner } from "node-pg-migrate";

export async function applyMigrations(url: string, migrationsDir: string): Promise<void> {
	await runner({
		databaseUrl: url,
		dir: migrationsDir,
		direction: "up",
		migrationsTable: "pgmigrations",
		// Sequential numeric prefixes (0001_, 0002_, …) rather than timestamps.
		// node-pg-migrate logs a warning for non-timestamp prefixes; suppress it.
		logger: {
			debug: () => {},
			info: (msg: unknown) => { console.log(msg); },
			warn: (msg: unknown) => { console.warn(msg); },
			error: (msg: unknown) => {
				if (typeof msg === "string" && msg.includes("Can't determine timestamp")) return;
				console.error(msg);
			},
		},
	});
}
