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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	gitBranchDelete,
	gitDeleteRef,
	gitMergeBase,
	gitRefExists,
	gitRevListCount,
	gitUpdateRef,
	headSha,
} from "../agent/extensions/bogstandard/git.js";

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

interface FakeCall {
	cmd: string;
	args: string[];
}

function makePi(responses: Array<Partial<ExecResult>>): {
	pi: ExtensionAPI;
	calls: FakeCall[];
} {
	const calls: FakeCall[] = [];
	let next = 0;
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			const r = responses[next++] ?? {};
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

describe("headSha", () => {
	it("invokes `git rev-parse HEAD` and returns the trimmed SHA", async () => {
		const { pi, calls } = makePi([{ stdout: "abcdef1234567890abcdef1234567890abcdef12\n" }]);
		const sha = await headSha(pi);
		expect(calls).toEqual([{ cmd: "git", args: ["rev-parse", "HEAD"] }]);
		expect(sha).toBe("abcdef1234567890abcdef1234567890abcdef12");
	});
});

describe("gitMergeBase", () => {
	it("invokes `git merge-base <a> <b>` and trims output", async () => {
		const { pi, calls } = makePi([{ stdout: "deadbeef\n" }]);
		const base = await gitMergeBase(pi, "HEAD", "main");
		expect(calls).toEqual([{ cmd: "git", args: ["merge-base", "HEAD", "main"] }]);
		expect(base).toBe("deadbeef");
	});
});

describe("gitRevListCount", () => {
	it("invokes `git rev-list --count <range>` and parses the number", async () => {
		const { pi, calls } = makePi([{ stdout: "7\n" }]);
		const n = await gitRevListCount(pi, "main..HEAD");
		expect(calls).toEqual([{ cmd: "git", args: ["rev-list", "--count", "main..HEAD"] }]);
		expect(n).toBe(7);
	});

	it("returns zero when the range is empty", async () => {
		const { pi } = makePi([{ stdout: "0\n" }]);
		expect(await gitRevListCount(pi, "main..HEAD")).toBe(0);
	});
});

describe("gitUpdateRef", () => {
	it("invokes `git update-ref <refName> <sha>`", async () => {
		const { pi, calls } = makePi([{}]);
		await gitUpdateRef(pi, "refs/bogstandard/issue-12", "abc123");
		expect(calls).toEqual([
			{ cmd: "git", args: ["update-ref", "refs/bogstandard/issue-12", "abc123"] },
		]);
	});

	it("throws with stderr content when git exits non-zero", async () => {
		const { pi } = makePi([{ code: 1, stderr: "fatal: bad ref name\n" }]);
		await expect(gitUpdateRef(pi, "refs/bogstandard/issue-12", "abc")).rejects.toThrow(
			/fatal: bad ref name/,
		);
	});
});

describe("gitDeleteRef", () => {
	it("invokes `git update-ref -d <refName>`", async () => {
		const { pi, calls } = makePi([{}]);
		await gitDeleteRef(pi, "refs/bogstandard/issue-12");
		expect(calls).toEqual([
			{ cmd: "git", args: ["update-ref", "-d", "refs/bogstandard/issue-12"] },
		]);
	});
});

describe("gitRefExists", () => {
	it("returns true when `git show-ref --verify --quiet` exits zero", async () => {
		const { pi, calls } = makePi([{ code: 0 }]);
		const exists = await gitRefExists(pi, "refs/bogstandard/issue-1");
		expect(calls).toEqual([
			{ cmd: "git", args: ["show-ref", "--verify", "--quiet", "refs/bogstandard/issue-1"] },
		]);
		expect(exists).toBe(true);
	});

	it("returns false when show-ref exits non-zero (and does not throw)", async () => {
		const { pi } = makePi([{ code: 1 }]);
		await expect(gitRefExists(pi, "refs/bogstandard/issue-1")).resolves.toBe(false);
	});
});

describe("gitBranchDelete", () => {
	it("uses -D when force is true (default)", async () => {
		const { pi, calls } = makePi([{}]);
		await gitBranchDelete(pi, "bogstandard/worker-1/issue-7");
		expect(calls).toEqual([
			{ cmd: "git", args: ["branch", "-D", "bogstandard/worker-1/issue-7"] },
		]);
	});

	it("uses -d when force is false", async () => {
		const { pi, calls } = makePi([{}]);
		await gitBranchDelete(pi, "bogstandard/worker-1/issue-7", false);
		expect(calls).toEqual([
			{ cmd: "git", args: ["branch", "-d", "bogstandard/worker-1/issue-7"] },
		]);
	});
});
