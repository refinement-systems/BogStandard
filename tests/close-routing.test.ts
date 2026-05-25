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
import { routeCloseAction } from "../agent/extensions/bogstandard/merge-handoff.js";

describe("routeCloseAction", () => {
	it("returns no_changes when working tree is clean and no commits ahead", () => {
		expect(routeCloseAction(true, 0)).toBe("no_changes");
	});

	it("returns publish_existing when tree is clean but commits ahead of main", () => {
		expect(routeCloseAction(true, 1)).toBe("publish_existing");
		expect(routeCloseAction(true, 5)).toBe("publish_existing");
	});

	it("returns commit_then_publish whenever the tree is dirty", () => {
		expect(routeCloseAction(false, 0)).toBe("commit_then_publish");
		expect(routeCloseAction(false, 3)).toBe("commit_then_publish");
	});
});
