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

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BS_RUN = resolve(REPO_ROOT, "bin/bs-run");

interface Fixture {
	dir: string;
	logPath: string;
	piPath: string;
	mergePath: string;
}

function setupFakes(opts: { piExit: number; mergeExit: number }): Fixture {
	const dir = mkdtempSync(resolve(tmpdir(), "bs-run-test-"));
	const fakeBin = resolve(dir, "fakebin");
	mkdirSync(fakeBin, { recursive: true });
	const logPath = resolve(dir, "calls.log");
	writeFileSync(logPath, "");

	// Fake pi: log invocation, exit with configured code.
	const piPath = resolve(fakeBin, "pi");
	writeFileSync(
		piPath,
		`#!/usr/bin/env bash
echo "pi $*" >> "${logPath}"
exit ${opts.piExit}
`,
	);

	// Fake bs-merge-worker (replaces the real wrapper inside BS_HOME/bin).
	// bs-run invokes "${BS_HOME}/bin/bs-merge-worker" by absolute path, so we
	// shim by pointing bs-run at a tempdir that mimics BS_HOME's bin layout.
	// Simpler: copy bin/bs-run into a tmp BS_HOME with our fake merge worker.
	const fakeHome = resolve(dir, "BS_HOME");
	const fakeHomeBin = resolve(fakeHome, "bin");
	mkdirSync(fakeHomeBin, { recursive: true });

	// Real bs-run, but inside our fake BS_HOME.
	const piPathReal = resolve(REPO_ROOT, "bin/bs-run");
	const bsRunContents = readFileSync(piPathReal, "utf8");
	const bsRunCopy = resolve(fakeHomeBin, "bs-run");
	writeFileSync(bsRunCopy, bsRunContents);

	const mergePath = resolve(fakeHomeBin, "bs-merge-worker");
	writeFileSync(
		mergePath,
		`#!/usr/bin/env bash
echo "merge $*" >> "${logPath}"
exit ${opts.mergeExit}
`,
	);

	// bs-run checks for tsx under BS_HOME/node_modules/.bin/tsx.  Stub it.
	const fakeTsxDir = resolve(fakeHome, "node_modules/.bin");
	mkdirSync(fakeTsxDir, { recursive: true });
	const fakeTsx = resolve(fakeTsxDir, "tsx");
	writeFileSync(fakeTsx, "#!/usr/bin/env bash\nexit 0\n");

	// And bs-run uses BS_HOME/agent/extensions/bogstandard as -e arg; the path
	// only needs to be passable as a string, no file existence is checked by
	// fake pi, so we don't need to create it.

	// Make everything executable.
	for (const p of [piPath, bsRunCopy, mergePath, fakeTsx]) {
		// chmod 0o755
		// eslint-disable-next-line no-bitwise
		// Use spawnSync to chmod portably.
		spawnSync("chmod", ["+x", p]);
	}

	return { dir, logPath, piPath: bsRunCopy, mergePath };
}

function runBsRun(fix: Fixture, args: string[]): {
	status: number;
	stdout: string;
	stderr: string;
	log: string;
} {
	const fakeBinDir = dirname(fix.piPath); // BS_HOME/bin where fake pi is NOT — pi is in tmp/fakebin
	const realFakeBin = resolve(fix.dir, "fakebin");
	const env = {
		...process.env,
		PATH: `${realFakeBin}:${process.env.PATH ?? ""}`,
		// bs-run resolves BS_HOME via $(dirname $BASH_SOURCE)/.. — by invoking
		// the copy at BS_HOME/bin/bs-run, BS_HOME resolves to our fake home.
	};
	const result = spawnSync(fix.piPath, args, {
		env,
		encoding: "utf8",
		cwd: fix.dir,
	});
	const log = readFileSync(fix.logPath, "utf8");
	return {
		status: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr,
		log,
	};
}

describe("bin/bs-run", () => {
	let fix: Fixture | undefined;
	afterEach(() => {
		if (fix) {
			rmSync(fix.dir, { recursive: true, force: true });
			fix = undefined;
		}
	});

	it("invokes pi with --bs-single-shot and /bs-task (no id), then runs merger once", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 0 });
		const r = runBsRun(fix, []);
		expect(r.status).toBe(0);
		expect(r.log).toMatch(/pi .*--bs-single-shot/);
		expect(r.log).toMatch(/pi .*\/bs-task/);
		expect(r.log).toMatch(/merge --once/);
		const piLine = r.log.split("\n").find((l) => l.startsWith("pi "))!;
		expect(piLine).not.toMatch(/\/bs-task \d/);
	});

	it("forwards a positional issue id after /bs-task", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 0 });
		const r = runBsRun(fix, ["42"]);
		expect(r.status).toBe(0);
		expect(r.log).toMatch(/pi .*--bs-single-shot .*\/bs-task 42/);
		expect(r.log).toMatch(/merge --once/);
	});

	it("forwards args after -- to pi (before /bs-task)", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 0 });
		const r = runBsRun(fix, ["--", "--bs-plan-model", "foo/bar"]);
		expect(r.status).toBe(0);
		expect(r.log).toMatch(
			/pi .*--bs-single-shot --bs-plan-model foo\/bar \/bs-task/,
		);
	});

	it("forwards issue id and pi args together", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 0 });
		const r = runBsRun(fix, ["42", "--", "--bs-impl-model", "foo/bar"]);
		expect(r.status).toBe(0);
		expect(r.log).toMatch(
			/pi .*--bs-single-shot --bs-impl-model foo\/bar \/bs-task 42/,
		);
	});

	it("does not run the merger when pi exits non-zero, and propagates the exit code", () => {
		fix = setupFakes({ piExit: 7, mergeExit: 0 });
		const r = runBsRun(fix, []);
		expect(r.status).toBe(7);
		expect(r.log).toMatch(/pi /);
		expect(r.log).not.toMatch(/merge /);
	});

	it("returns the merger exit code when pi succeeded but the merger failed", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 9 });
		const r = runBsRun(fix, []);
		expect(r.status).toBe(9);
		expect(r.log).toMatch(/merge --once/);
	});

	it("rejects unexpected positional args after the issue id (without --)", () => {
		fix = setupFakes({ piExit: 0, mergeExit: 0 });
		const r = runBsRun(fix, ["42", "garbage"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/unexpected argument/);
		expect(r.log).toBe("");
	});
});
