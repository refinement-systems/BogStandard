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

export type ShutdownBoundary =
	| "queued_for_merge"
	| "no_change_closed"
	| "no_eligible"
	| "invalid_issue"
	| "missing_needs_tests"
	| "claim_failed"
	| "dirty_tree"
	| "aborted_before_planning"
	| "aborted_resume_or_plan_review"
	| "redraft_proposed"
	| "wip_quit"
	| "continue_cancelled"
	| "continue_working";

export function shouldShutdownInSingleShot(
	flag: boolean | undefined,
	boundary: ShutdownBoundary,
): boolean {
	if (!flag) return false;
	return boundary !== "continue_working";
}
