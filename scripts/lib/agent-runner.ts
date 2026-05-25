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
 * Thin re-export wrapper for @earendil-works/pi-agent-core and
 * @earendil-works/pi-ai.
 *
 * These packages are not on the public npm registry; they ship inside pi's
 * global installation. At runtime, NODE_PATH is set to pi's node_modules by
 * bin/bs-merge-worker so resolution succeeds.
 *
 * In tests, vi.mock("../scripts/lib/agent-runner.js") intercepts this module
 * before resolution is attempted, so the real packages never need to be
 * installed to run `npm test`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "@earendil-works/pi-agent-core";

export type { Static, TSchema } from "@earendil-works/pi-ai";

function resolvePiCodingAgentRoot(): string {
	let npmGlobalRoot: string | undefined;
	try {
		npmGlobalRoot = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
		}).trim();
	} catch {
		npmGlobalRoot = undefined;
	}

	const candidates = [
		process.env.PI_CODING_AGENT_ROOT,
		npmGlobalRoot && join(npmGlobalRoot, "@earendil-works", "pi-coding-agent"),
		...(process.env.NODE_PATH ?? "").split(delimiter).flatMap((entry) => {
			if (!entry) return [];
			return [
				entry,
				join(entry, "@earendil-works", "pi-coding-agent"),
				join(entry, ".."),
			];
		}),
	].filter((entry): entry is string => typeof entry === "string" && entry !== "");

	for (const candidate of candidates) {
		if (
			existsSync(join(candidate, "package.json")) &&
			existsSync(join(candidate, "dist", "index.js"))
		) {
			return candidate;
		}
	}

	throw new Error(
		"Cannot resolve @earendil-works/pi-coding-agent. Run through bin/bs-merge-worker so PI_CODING_AGENT_ROOT is set.",
	);
}

const piRoot = resolvePiCodingAgentRoot();
const agentCore = await import(
	pathToFileURL(
		join(piRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
	).href
);
const piAi = await import(
	pathToFileURL(
		join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
	).href
);
const codingAgent = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);

export const runAgentLoopContinue = agentCore.runAgentLoopContinue;
export const convertToLlm = agentCore.convertToLlm;

export const getModel = piAi.getModel;
export const getEnvApiKey = piAi.getEnvApiKey;
export const Type = piAi.Type;

export const createReadTool = codingAgent.createReadTool;
export const createGrepTool = codingAgent.createGrepTool;
export const createFindTool = codingAgent.createFindTool;
export const createLsTool = codingAgent.createLsTool;
export const createBashTool = codingAgent.createBashTool;
export const createEditTool = codingAgent.createEditTool;
export const createWriteTool = codingAgent.createWriteTool;
