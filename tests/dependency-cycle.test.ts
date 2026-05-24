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
import { CYCLE_CHECK_SQL } from "../agent/extensions/bogstandard/db.js";

describe("CYCLE_CHECK_SQL", () => {
	it("uses a recursive CTE walking blocker→blocked", () => {
		expect(CYCLE_CHECK_SQL).toMatch(/WITH RECURSIVE/);
		expect(CYCLE_CHECK_SQL).toMatch(/d\.blocker_id = r\.id/);
		expect(CYCLE_CHECK_SQL).toMatch(/d\.blocked_id/);
	});

	it("seeds the walk from $1 (the new edge's blocked_id)", () => {
		expect(CYCLE_CHECK_SQL).toMatch(/SELECT \$1::bigint/);
	});

	it("checks reachability of $2 (the new edge's blocker_id)", () => {
		expect(CYCLE_CHECK_SQL).toMatch(/WHERE id = \$2/);
	});

	it("returns at most one row (LIMIT 1)", () => {
		expect(CYCLE_CHECK_SQL).toMatch(/LIMIT 1/);
	});
});
