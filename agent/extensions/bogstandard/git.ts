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
 * Typed wrappers over `pi.exec("git", ...)`.
 *
 * Replaces the inline `git` calls in today's shell orchestrator. The bash
 * relied on exit-code testing (`git diff --cached --quiet`) for control
 * flow; here we expose explicit booleans so callers don't need to know
 * git's exit conventions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function run(
	pi: ExtensionAPI,
	args: string[],
	options?: { signal?: AbortSignal; allowNonZero?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("git", args, { signal: options?.signal });
	if (!options?.allowNonZero && result.code !== 0) {
		throw new Error(
			`git ${args.join(" ")} exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
		);
	}
	return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export async function statusShort(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(pi, ["status", "--short"], { signal });
	return stdout;
}

export async function isClean(pi: ExtensionAPI, signal?: AbortSignal): Promise<boolean> {
	const { stdout } = await run(pi, ["status", "--porcelain"], { signal });
	return stdout.trim() === "";
}

export async function addAll(pi: ExtensionAPI, signal?: AbortSignal): Promise<void> {
	await run(pi, ["add", "-A"], { signal });
}

export async function hasStagedChanges(pi: ExtensionAPI, signal?: AbortSignal): Promise<boolean> {
	// `git diff --cached --quiet` exits 0 if there are NO changes, 1 if there are.
	const { code } = await run(pi, ["diff", "--cached", "--quiet"], { signal, allowNonZero: true });
	return code !== 0;
}

export async function commit(
	pi: ExtensionAPI,
	title: string,
	body?: string,
	signal?: AbortSignal,
): Promise<void> {
	const args = ["commit", "-m", title];
	if (body !== undefined && body !== "") {
		args.push("-m", body);
	}
	await run(pi, args, { signal });
}

export async function showHeadDiff(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(pi, ["show", "HEAD", "--stat", "--patch", "--no-color"], { signal });
	return stdout;
}

export async function resetHardHeadMinus1(pi: ExtensionAPI, signal?: AbortSignal): Promise<void> {
	await run(pi, ["reset", "--hard", "HEAD~1"], { signal });
}

export async function resetHardToRef(pi: ExtensionAPI, ref: string, signal?: AbortSignal): Promise<void> {
	await run(pi, ["reset", "--hard", ref], { signal });
}

export async function headShortSha(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(pi, ["rev-parse", "--short", "HEAD"], { signal });
	return stdout.trim();
}

export async function currentBranch(pi: ExtensionAPI, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const { stdout } = await run(pi, ["rev-parse", "--abbrev-ref", "HEAD"], { signal });
		const name = stdout.trim();
		return name === "HEAD" ? undefined : name; // detached HEAD → undefined
	} catch {
		return undefined;
	}
}

export async function headSha(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(pi, ["rev-parse", "HEAD"], { signal });
	return stdout.trim();
}

export async function gitMergeBase(
	pi: ExtensionAPI,
	a: string,
	b: string,
	signal?: AbortSignal,
): Promise<string> {
	const { stdout } = await run(pi, ["merge-base", a, b], { signal });
	return stdout.trim();
}

export async function gitRevListCount(
	pi: ExtensionAPI,
	range: string,
	signal?: AbortSignal,
): Promise<number> {
	const { stdout } = await run(pi, ["rev-list", "--count", range], { signal });
	return Number.parseInt(stdout.trim(), 10);
}

export async function gitUpdateRef(
	pi: ExtensionAPI,
	refName: string,
	sha: string,
	signal?: AbortSignal,
): Promise<void> {
	await run(pi, ["update-ref", refName, sha], { signal });
}

export async function gitDeleteRef(
	pi: ExtensionAPI,
	refName: string,
	signal?: AbortSignal,
): Promise<void> {
	await run(pi, ["update-ref", "-d", refName], { signal });
}

export async function gitRefExists(
	pi: ExtensionAPI,
	refName: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const { code } = await run(pi, ["show-ref", "--verify", "--quiet", refName], {
		signal,
		allowNonZero: true,
	});
	return code === 0;
}

export async function gitBranchDelete(
	pi: ExtensionAPI,
	branch: string,
	force = true,
	signal?: AbortSignal,
): Promise<void> {
	await run(pi, ["branch", force ? "-D" : "-d", branch], { signal });
}

export async function gitCheckoutDetachHead(
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<void> {
	await run(pi, ["checkout", "--detach", "HEAD"], { signal });
}
