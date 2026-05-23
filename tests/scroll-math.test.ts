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
import {
	clampScrollOffset,
	pageScroll,
	pageSize,
} from "../agent/extensions/bogstandard/scroll-math.js";

describe("clampScrollOffset", () => {
	it("clamps negative offset to 0", () => {
		expect(clampScrollOffset(-5, 100, 10)).toBe(0);
	});

	it("clamps offset above max to maxOffset", () => {
		expect(clampScrollOffset(999, 100, 10)).toBe(90);
	});

	it("returns 0 when totalLines fits in viewport", () => {
		expect(clampScrollOffset(0, 5, 10)).toBe(0);
		expect(clampScrollOffset(50, 5, 10)).toBe(0);
	});

	it("returns 0 when totalLines equals viewportHeight (no scrolling needed)", () => {
		expect(clampScrollOffset(0, 10, 10)).toBe(0);
		expect(clampScrollOffset(5, 10, 10)).toBe(0);
	});

	it("preserves in-range offset", () => {
		expect(clampScrollOffset(40, 100, 10)).toBe(40);
	});

	it("treats viewportHeight greater than totalLines as a single page (max 0)", () => {
		expect(clampScrollOffset(3, 2, 10)).toBe(0);
	});
});

describe("pageSize", () => {
	it("returns floor(viewportHeight * 0.8), floored to 5 minimum", () => {
		expect(pageSize(20)).toBe(16);
		expect(pageSize(10)).toBe(8);
	});

	it("returns the 5-line floor for small viewports", () => {
		expect(pageSize(1)).toBe(5);
		expect(pageSize(6)).toBe(5); // floor(6*0.8)=4, below floor → 5
		expect(pageSize(7)).toBe(5); // floor(7*0.8)=5
	});
});

describe("pageScroll", () => {
	it("pages down from 0 to pageSize", () => {
		expect(pageScroll(0, 1, 20, 200)).toBe(16);
	});

	it("pages up from 0 stays at 0", () => {
		expect(pageScroll(0, -1, 20, 200)).toBe(0);
	});

	it("pages down past the end clamps to maxOffset", () => {
		expect(pageScroll(180, 1, 20, 200)).toBe(180); // 200 - 20 = 180
		expect(pageScroll(170, 1, 20, 200)).toBe(180); // 170 + 16 = 186 → clamped to 180
	});

	it("pages up past the start clamps to 0", () => {
		expect(pageScroll(10, -1, 20, 200)).toBe(0);
	});
});
