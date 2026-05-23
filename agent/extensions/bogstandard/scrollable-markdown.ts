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
 * ScrollableMarkdownView — a full-pane component that renders a markdown body
 * with pi's `Markdown` component, paginated by an internal scroll offset, and
 * exits via caller-supplied action keys.
 *
 * Used for both issue review (action keys: continue / comment / show / abort)
 * and plan review (action keys: accept / refine-or-abort). Replaces the
 * sendMessage + ctx.ui.select dance for issue review, and the ctx.ui.editor
 * workaround for plan review.
 *
 * Scroll math lives in `./scroll-math.ts` so it can be unit-tested without
 * pulling in pi at runtime (the test harness has no pi packages installed).
 */

import {
	type Component,
	type KeyId,
	Markdown,
	matchesKey,
	TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type ExtensionContext, getMarkdownTheme, Theme } from "@earendil-works/pi-coding-agent";
import { clampScrollOffset, pageScroll } from "./scroll-math.js";

export interface ScrollableMarkdownAction<T> {
	/** Key identifier per pi-tui's `matchesKey`, e.g. "return", "escape", "c", "shift+g". */
	keyId: KeyId;
	/** Footer hint label, e.g. "↵ continue", "c comment". */
	label: string;
	/** Value returned to the caller via `done()`. */
	result: T;
}

export interface ScrollableMarkdownOptions<T> {
	title: string;
	markdown: string;
	actions: readonly ScrollableMarkdownAction<T>[];
}

/**
 * Maximum vertical share of the terminal the viewer is allowed to claim
 * (header + body + footer). The chat history above takes the remainder.
 */
const MAX_HEIGHT_RATIO = 0.6;
const MIN_HEIGHT = 10;

const HEADER_LINES = 3; // title, rule, blank
const FOOTER_LINES = 2; // blank, hints

export class ScrollableMarkdownView<T> implements Component {
	private scrollOffset = 0;
	private readonly md: Markdown;
	private lastWidth = -1;
	private cachedBodyLength = 0;
	private cachedViewportHeight = 1;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly opts: ScrollableMarkdownOptions<T>,
		private readonly done: (result: T) => void,
	) {
		this.md = new Markdown(opts.markdown, 1, 0, getMarkdownTheme());
	}

	render(width: number): string[] {
		if (width !== this.lastWidth) {
			this.md.invalidate();
			this.lastWidth = width;
		}

		const terminalRows = this.tui.terminal.rows;
		const maxRows = Math.max(MIN_HEIGHT, Math.floor(terminalRows * MAX_HEIGHT_RATIO));
		const viewportHeight = Math.max(1, maxRows - HEADER_LINES - FOOTER_LINES);

		const body = this.md.render(width);
		this.scrollOffset = clampScrollOffset(this.scrollOffset, body.length, viewportHeight);

		this.cachedBodyLength = body.length;
		this.cachedViewportHeight = viewportHeight;

		const visible = body.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
		const blank = " ".repeat(width);
		while (visible.length < viewportHeight) {
			visible.push(blank);
		}

		return [...this.renderHeader(width), ...visible, ...this.renderFooter(width, body.length)];
	}

	invalidate(): void {
		this.md.invalidate();
	}

	handleInput(data: string): void {
		// Action keys take precedence so callers can override built-in scroll keys
		// if needed (e.g. binding `g` to an action would shadow "scroll to top").
		for (const action of this.opts.actions) {
			if (matchesKey(data, action.keyId)) {
				this.done(action.result);
				return;
			}
		}

		const viewport = this.cachedViewportHeight;
		const total = this.cachedBodyLength;

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = clampScrollOffset(this.scrollOffset + 1, total, viewport);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = pageScroll(this.scrollOffset, -1, viewport, total);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
			this.scrollOffset = pageScroll(this.scrollOffset, 1, viewport, total);
		} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.scrollOffset = Math.max(0, total - viewport);
		} else {
			return;
		}

		this.tui.requestRender();
	}

	private renderHeader(width: number): string[] {
		const title = truncateToWidth(this.opts.title, width - 2);
		const titleLine = ` ${this.theme.bold(this.theme.fg("accent", title))}`;
		const rule = this.theme.fg("dim", "─".repeat(width));
		return [titleLine, rule, " ".repeat(width)];
	}

	private renderFooter(width: number, totalLines: number): string[] {
		const hints: string[] = ["↑↓ scroll", "⇞⇟ page", "g/G top/bottom"];
		for (const a of this.opts.actions) hints.push(a.label);
		let line = hints.join(" · ");

		if (totalLines > this.cachedViewportHeight) {
			const first = this.scrollOffset + 1;
			const last = Math.min(this.scrollOffset + this.cachedViewportHeight, totalLines);
			line = `${line}  [${first}-${last}/${totalLines}]`;
		}

		return [" ".repeat(width), ` ${this.theme.fg("dim", truncateToWidth(line, width - 2))}`];
	}
}

/**
 * Mount a ScrollableMarkdownView via `ctx.ui.custom` and await the user's
 * action choice. Non-overlay: the viewer takes over pi's editor area for the
 * duration; the chat history above is unchanged.
 */
export async function showScrollableMarkdown<T>(
	ctx: ExtensionContext,
	opts: ScrollableMarkdownOptions<T>,
): Promise<T> {
	return await ctx.ui.custom<T>((tui, theme, _kb, done) => {
		return new ScrollableMarkdownView<T>(tui, theme, opts, done);
	});
}
