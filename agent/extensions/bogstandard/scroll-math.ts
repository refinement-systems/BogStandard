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
