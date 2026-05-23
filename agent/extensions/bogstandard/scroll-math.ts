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
 * Pure scroll-math helpers for `ScrollableMarkdownView`. Lives in its own
 * module (no pi imports) so the math is unit-testable without spinning up
 * the TUI runtime.
 *
 * Mirrors the clamping/page-step logic in pi's editor component
 * (`packages/tui/src/components/editor.ts:434–443` and `:1745–1748`).
 */

export function clampScrollOffset(offset: number, totalLines: number, viewportHeight: number): number {
	const maxOffset = Math.max(0, totalLines - viewportHeight);
	return Math.max(0, Math.min(offset, maxOffset));
}

export function pageSize(viewportHeight: number): number {
	return Math.max(5, Math.floor(viewportHeight * 0.8));
}

export function pageScroll(
	offset: number,
	direction: -1 | 1,
	viewportHeight: number,
	totalLines: number,
): number {
	return clampScrollOffset(offset + direction * pageSize(viewportHeight), totalLines, viewportHeight);
}
