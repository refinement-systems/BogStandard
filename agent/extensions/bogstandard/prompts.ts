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
 * Phase-specific prompt builders, ported from agent/prompts/*.md.
 *
 * In the shell orchestrator the prompt templates took positional args
 * (`$1` = plan file, `$2` = issue JSON path) and the planner/implementer
 * read those off disk. In the extension version we synthesize the prompts
 * in TypeScript with the relevant content inlined, so no temp files cross
 * the boundary.
 *
 * The planner returns its plan by calling the `save_plan` tool (which
 * `terminate`s the agent loop), not by writing to a file. Implementer
 * still does file edits via the standard tools.
 */

import type { IssueDetail } from "./db.js";
import { buildIssueDisplay } from "./db.js";

const PLANNER_COMMENT_KINDS = new Set(["note", "decision", "observation", "human"]);

export function buildPlannerSystemPrompt(): string {
	return `You are a software architect. Your job is to explore the codebase, resolve ambiguities, and emit a plan. You do not write or modify code.

Available tools:
- read, grep, find, ls — explore the codebase
- bash — non-mutating inspection only (rg, cat, wc, etc. are fine; writes, git, and direct database access are not); prefer grep/find/ls over bash for file exploration — they are faster and respect .gitignore
- questionnaire(questions) — ask the user structured multiple-choice questions when ambiguity cannot be resolved from the codebase alone; call before finalising the plan
- save_plan(plan) — emit the finished plan and end the session; call exactly once when the plan is finalised, then stop immediately
- propose_redraft(diagnosis) — call this if you believe the issue itself is wrong, contradicts the codebase, or cannot be sensibly planned as written. Supply a precise diagnosis. The user will choose to continue, discuss, or bail back to the Designer for a redraft. Use this only when the issue itself needs to change — not for ordinary clarifications, which belong to \`questionnaire\`.

Rules:
- Do not modify any file
- Do not run git commands
- Do not write to the issue database directly`;
}

export function buildImplementerSystemPrompt(): string {
	return `You are a software engineer. Your job is to implement the plan provided to you exactly as written.

Available tools:
- read, grep, find, ls, bash — read and inspect the codebase
- edit, write — modify and create files

Rules:
- Do not run git commands — the extension handles all git operations
- Do not write to the issue database directly — the extension handles issue closing
- Do not add code outside the scope of the issue`;
}

export function buildGreenImplementerSystemPrompt(): string {
	return `${buildImplementerSystemPrompt()}

Additional tool:
- bail_out(reason) — call this if the red-phase tests are fundamentally unsatisfiable without modifying them; supply a precise diagnosis and stop immediately after calling it`;
}

function renderIssueBlock(issue: IssueDetail): string {
	const filteredComments = (issue.comments ?? []).filter((c) => PLANNER_COMMENT_KINDS.has(c.kind));
	const sanitized = {
		id: issue.id,
		title: issue.title,
		priority: issue.priority,
		description: issue.description,
		needs_tests: issue.needs_tests,
		workflow_id: issue.workflow_id,
		comments: filteredComments,
	};
	const json = JSON.stringify(sanitized, null, 2);
	const display = buildIssueDisplay({ ...issue, comments: filteredComments });
	const sections: string[] = [];
	sections.push(`Issue #${issue.id}: ${issue.title}`);
	if (display.trim() !== "") {
		sections.push("---");
		sections.push(display);
	}
	sections.push("---");
	sections.push("Raw JSON (fields: title, description, priority, needs_tests, workflow_id, comments):");
	sections.push("```json");
	sections.push(json);
	sections.push("```");
	return sections.join("\n\n");
}

/**
 * Planner phase: explore, optionally clarify, then call `save_plan`.
 * Read-only tools only. Mirrors agent/prompts/bogstandard-plan-issue-no-tests.md
 * minus the file-path indirection.
 */
export function buildPlanPrompt(issue: IssueDetail): string {
	return `# Issue

${renderIssueBlock(issue)}

# Plan Mode

You work in 3 explicit phases. Do not skip ahead. Do not implement anything while planning.

## Phase 1 — Ground in the repo

First, explore the codebase with read-only tools so you understand the current state, relevant files, and existing conventions.

Rules for this phase:
- Resolve every discoverable question by reading the repo before asking the user anything
- Do not ask about facts that can be learned from the codebase or issue data
- Do not call \`save_plan\` yet unless the issue is already decision-complete
- If the issue description references work expected to be completed by prior blocking issues, verify that those artifacts are present in the codebase. Do not assume DB state reflects codebase state. If expected artifacts are missing, call \`propose_redraft\` with a precise diagnosis — do not plan work that builds on an absent foundation.

## Phase 2 — Clarify with the user

After exploration, identify only the remaining unknowns that would materially change the plan. For each such unknown, call \`questionnaire\`.

Treat the issue as still ambiguous if any scope boundary, implementation decision fork, or plan-shaping choice remains unresolved after Phase 1 and repo inspection cannot conclusively settle it, even when repo conventions suggest a likely default.

Question rules:
- Ask only questions that materially change the plan, lock an assumption, or choose between meaningful tradeoffs
- Do not ask filler questions
- Do not ask about anything that could have been discovered in Phase 1
- Each question must offer 2 to 4 mutually exclusive options
- Put the recommended option first and suffix its label with \`(Recommended)\`
- Do not include an \`Other\` option; the questionnaire tool adds it automatically
- Prefer concrete options tied to repo conventions, architecture, scope, naming, or file placement

If material ambiguity remains after Phase 1, you must call \`questionnaire\` before finalizing the plan.

If the \`questionnaire\` tool returns an error indicating no UI is available, do not retry. Instead:
- make the best assumption you can from the issue description and repo conventions
- record it in \`## Resolved Questions\` prefixed with \`[Assumed]\`

If the issue is unambiguous after Phase 1, skip Phase 2 and proceed directly to Phase 3.

## Phase 3 — Finalize the plan

Only finalize once the spec is decision-complete and a junior implementer could execute it without making judgment calls. Do not advance from Phase 2 to Phase 3 while a material ambiguity remains unresolved unless \`questionnaire\` was actually called and returned no-UI failure.

Emit the plan by calling the \`save_plan\` tool with the full markdown content. The plan must be implementation-focused and concise, with enough detail to execute safely.

The plan markdown must contain these sections, in this order:

## Context
Why this change is needed and what problem it solves.

## Approach
The chosen implementation strategy and the reasoning behind it.

## Files to Modify
An explicit list of files and the specific changes required in each.

## Implementation Steps
Ordered, concrete steps the implementation agent should follow. Each step must be specific enough to execute without ambiguity.

## Edge Cases
Any tricky scenarios, constraints, or failure modes to handle.

## Resolved Questions
A short list covering:
- every clarifying question you asked
- the chosen answer
- a brief reason
- any assumptions you made without asking the user

Formatting rules for \`## Resolved Questions\`:
- Use one bullet per item
- Each bullet must be exactly one of:
  - a real \`questionnaire\` interaction with the chosen answer and a brief reason
  - an \`[Assumed]\` fallback caused by the no-UI error
  - a single explicit statement that no clarifying questions were needed
- If no clarifying questions were needed, say so explicitly and do not imply that one occurred
- Prefix unilateral assumptions made during headless fallback with \`[Assumed]\`
- Do not claim, imply, or format a clarification as user-answered unless \`questionnaire\` was actually invoked

Global rules:
- Do NOT leave the plan ambiguous on key architecture, scope, naming, library, or file-placement decisions

When the plan is ready, call \`save_plan\` with the markdown as the \`plan\` parameter. After \`save_plan\` returns, stop. Do not call other tools.
`;
}

/**
 * Implementer phase: follow the approved plan, edit files, exit when done.
 * Mirrors agent/prompts/bogstandard-implement-issue.md.
 */
export function buildImplementPrompt(issue: IssueDetail, plan: string): string {
	return `Read the plan in full before touching anything. Then read all source files mentioned in the plan and implement each step in the Implementation Steps section in order.

After implementation, run any verification commands listed in the plan and fix any failures before finishing.

# Approved Plan

${plan}

# Issue

${renderIssueBlock(issue)}

> **Recovery note:** If the working tree is already dirty when this phase starts, a previous session may have left partial work on disk. Inspect the current state (\`git status\`, \`git diff\`), continue where the previous session left off, and finish the implementation before signaling completion.

Rules:
- Follow the plan closely; if you discover the plan is wrong or incomplete, ask the user for clarification.
`;
}

/**
 * Red-phase planner: produce a plan for failing tests.
 * Mirrors agent/prompts/bogstandard-plan-red-issue.md.
 */
export function buildRedPlanPrompt(issue: IssueDetail): string {
	return `This is the **red** phase of a red/green TDD cycle. The plan you write describes the tests that capture the desired behavior of the feature. The implementation agent that consumes this plan will write those tests, run them, and confirm that they fail because the production code does not yet exist. The plan must not include any production-code changes — those happen in the green phase.

# Issue

${renderIssueBlock(issue)}

# Plan Mode

You work in 3 explicit phases. Do not skip ahead. Do not implement anything while planning.

## Phase 1 — Ground in the repo

First, explore the codebase and issue context with read-only tools so you understand the current state, the existing test layout, the test framework(s) in use, the test runner command(s), and the conventions for naming and structuring tests.

Rules for this phase:
- Resolve every discoverable question by reading the repo before asking the user anything
- Do not ask about facts that can be learned from the codebase or issue data
- Do not call \`save_plan\` yet unless the test design is already decision-complete
- If the issue description references work completed by prior blocking issues, verify which parts of the described feature are already implemented. Only plan tests for behavior that is not yet present in the codebase — writing red tests for already-implemented code produces a green-from-the-start test suite, defeating the red/green cycle. If expected prerequisite artifacts are missing entirely, call \`propose_redraft\` with a precise diagnosis.

## Phase 2 — Clarify with the user

After exploration, identify only the remaining unknowns that would materially change the test plan (e.g. which behaviors are in scope, what the contract should be at boundaries, what fixtures already exist). For each such unknown, call \`questionnaire\`.

Question rules:
- Ask only questions that materially change the test plan or lock an assumption about the desired behavior
- Do not ask filler questions
- Do not ask about anything that could have been discovered in Phase 1
- Each question must offer 2 to 4 mutually exclusive options
- Put the recommended option first and suffix its label with \`(Recommended)\`
- Do not include an \`Other\` option; the questionnaire tool adds it automatically

If material ambiguity remains after Phase 1, you must call \`questionnaire\` before finalizing the plan.

If the \`questionnaire\` tool returns an error indicating no UI is available, do not retry. Instead:
- make the best assumption you can from the issue description and repo conventions
- record it in \`## Resolved Questions\` prefixed with \`[Assumed]\`

If the test design is unambiguous after Phase 1, skip Phase 2 and proceed directly to Phase 3.

## Phase 3 — Finalize the plan

Only finalize once a junior implementer could write the tests without making judgment calls about scope or assertions.

Emit the plan by calling the \`save_plan\` tool with the full markdown content. The plan must be test-focused and concise.

The plan markdown must contain these sections, in this order:

## Context
Why this change is needed and what problem it solves.

## Approach
The test design strategy: what behaviors are exercised, what assertions are made, what test framework and runner are used, where the new tests live.

## Test Files to Create or Modify
An explicit list of test files and the specific tests to add to each. Identify any new fixtures, factories, or helpers required. **Do not list production-code files here** — production-code changes belong to the green phase.

## Implementation Steps
Ordered, concrete steps the implementation agent should follow to write the tests. Each step must be specific enough to execute without ambiguity. Steps must only touch test files, fixtures, factories, and test-only helpers.

## Expected Failure Modes
For each new test, describe how it should fail when the production code does not exist (e.g. "assertion failure on the returned value", "ImportError because module X is not yet present"). The implementation agent uses this section to confirm that the failure is genuine and not an accident of test infrastructure.

## How to Run the Tests
The exact command(s) the implementation agent must run to verify the tests fail.

## Edge Cases
Any tricky scenarios, constraints, or failure modes to capture in the tests.

## Resolved Questions
A short list covering:
- every clarifying question you asked
- the chosen answer
- a brief reason
- any assumptions you made without asking the user

Formatting rules for \`## Resolved Questions\`:
- Use one bullet per item
- Each bullet must be exactly one of:
  - a real \`questionnaire\` interaction with the chosen answer and a brief reason
  - an \`[Assumed]\` fallback caused by the no-UI error
  - a single explicit statement that no clarifying questions were needed
- If no clarifying questions were needed, say so explicitly and do not imply that one occurred

Global rules:
- Do NOT plan any production-code changes; production code is the green phase, not the red phase

When the plan is ready, call \`save_plan\` with the markdown as the \`plan\` parameter. After \`save_plan\` returns, stop. Do not call other tools.
`;
}

/**
 * Red-phase implementer: write failing tests.
 * Mirrors agent/prompts/bogstandard-implement-red-issue.md.
 */
export function buildRedImplementPrompt(issue: IssueDetail, plan: string): string {
	return `You are writing tests for a feature that does not exist yet. The terminal state of this session is **failing tests** — that failure is the deliverable. After writing the tests, run the test suite and record the failure output in your final message. Do **not** modify, create, or stub any non-test source file to make the tests pass. Do not add \`skip\`, \`xfail\`, \`pending\`, or \`todo\` markers. Do not weaken assertions. If a test fails for the wrong reason (import error, syntax error, fixture missing), fix only the test infrastructure so the failure becomes a real assertion failure about missing behavior, then stop.

Read the plan in full before touching anything. Then read all test files mentioned in the plan and create or modify the test files exactly as the \`Implementation Steps\` section dictates. Run the test command listed in the plan's \`How to Run the Tests\` section, confirm that each new test fails in a way consistent with the plan's \`Expected Failure Modes\` section, and include the failing output in your final message.

# Approved Red-Phase Plan

${plan}

# Issue

${renderIssueBlock(issue)}

> **Recovery note:** If the working tree is already dirty when this phase starts, a previous session may have left partial work on disk. Inspect the current state (\`git status\`, \`git diff\`), continue where the previous session left off, and finish the implementation before signaling completion.

Rules:
- Write tests only. Do NOT add, modify, or stub any production-code file.
- Do NOT add \`skip\`, \`xfail\`, \`pending\`, \`todo\`, \`xit\`, \`it.skip\`, or any other marker that suppresses the test or its assertions.
- Do NOT weaken assertions to make a test pass.
- Failing tests are the desired outcome; do not "fix" them by changing source code.
- If a test fails for the wrong reason (e.g. an import error in the test file itself, a fixture path typo, missing test dependency), fix only the test infrastructure so the failure becomes a real assertion failure about the missing behavior, then stop.
- Follow the plan closely; if you discover the plan is wrong or incomplete, ask the user for clarification.
`;
}

/**
 * Green-phase planner: plan the production code that makes the red tests pass.
 * Mirrors agent/prompts/bogstandard-plan-green-issue.md.
 */
export function buildGreenPlanPrompt(issue: IssueDetail, redDiff: string): string {
	return `This is the **green** phase of a red/green TDD cycle. The red phase has already added failing tests in a single commit; the diff for that commit is included below. Treat the new test files as the **contract** for the implementation. The plan you write describes the production-code changes needed to make those tests pass without modifying the tests themselves.

# Issue

${renderIssueBlock(issue)}

# Red-phase diff (the commit that introduced the failing tests)

\`\`\`diff
${redDiff}
\`\`\`

# Plan Mode

You work in 3 explicit phases. Do not skip ahead. Do not implement anything while planning.

## Phase 1 — Ground in the repo

First, read the red-phase diff above and the test files it introduced. Then explore the codebase with read-only tools so you understand the current state, the relevant production-code modules, and the existing conventions.

Rules for this phase:
- Treat the test files added in the red-phase diff as the contract; the implementation must satisfy them without modification
- Resolve every discoverable question by reading the repo before asking the user anything
- Do not ask about facts that can be learned from the codebase, the red-phase diff, or the issue data
- Do not call \`save_plan\` yet unless the implementation is decision-complete

## Phase 2 — Clarify with the user

After exploration, identify only the remaining unknowns that would materially change the plan. For each such unknown, call \`questionnaire\`.

Question rules:
- Ask only questions that materially change the plan, lock an assumption, or choose between meaningful tradeoffs that the tests do not already pin down
- Do not ask filler questions
- Do not ask about anything that could have been discovered in Phase 1
- Each question must offer 2 to 4 mutually exclusive options
- Put the recommended option first and suffix its label with \`(Recommended)\`
- Do not include an \`Other\` option; the questionnaire tool adds it automatically

If material ambiguity remains after Phase 1, you must call \`questionnaire\` before finalizing the plan.

If the \`questionnaire\` tool returns an error indicating no UI is available, do not retry. Instead:
- make the best assumption you can from the issue description, the red-phase diff, and repo conventions
- record it in \`## Resolved Questions\` prefixed with \`[Assumed]\`

If the implementation is unambiguous after Phase 1, skip Phase 2 and proceed directly to Phase 3.

## Phase 3 — Finalize the plan

Only finalize once a junior implementer could execute the plan without making judgment calls.

Emit the plan by calling the \`save_plan\` tool with the full markdown content. The plan must be implementation-focused and concise.

The plan markdown must contain these sections, in this order:

## Context
Why this change is needed and what problem it solves.

## Approach
The chosen implementation strategy and the reasoning behind it. Reference the specific tests in the red-phase diff that drive each design decision.

## Files to Modify
An explicit list of production-code files and the specific changes required in each. **Do not list test files here.** The tests added in the red phase must not be modified by the green phase.

## Implementation Steps
Ordered, concrete steps the implementation agent should follow. Each step must be specific enough to execute without ambiguity.

## Test Verification
The exact command(s) to run the tests added in the red phase, and the expected pass/skip/fail counts.

## Edge Cases
Any tricky scenarios, constraints, or failure modes to handle.

## Resolved Questions
A short list covering:
- every clarifying question you asked
- the chosen answer
- a brief reason
- any assumptions you made without asking the user

Formatting rules for \`## Resolved Questions\`:
- Use one bullet per item
- Each bullet must be exactly one of:
  - a real \`questionnaire\` interaction with the chosen answer and a brief reason
  - an \`[Assumed]\` fallback caused by the no-UI error
  - a single explicit statement that no clarifying questions were needed
- If no clarifying questions were needed, say so explicitly and do not imply that one occurred

Global rules:
- Do NOT plan any changes to the test files added in the red phase; those are the contract
- Do NOT leave the plan ambiguous on key architecture, scope, naming, library, or file-placement decisions

When the plan is ready, call \`save_plan\` with the markdown as the \`plan\` parameter. After \`save_plan\` returns, stop. Do not call other tools.
`;
}

/**
 * Green-phase implementer: make the red tests pass without touching them.
 * Mirrors agent/prompts/bogstandard-implement-green-issue.md.
 */
export function buildGreenImplementPrompt(issue: IssueDetail, plan: string, redDiff: string): string {
	return `The red phase already added failing tests in a single commit. The diff for that commit is included below. Your job is to implement the production-code changes described in the plan so that those tests pass — without modifying the tests themselves.

Read the plan in full before touching anything. Then read all source files mentioned in the plan and implement each step in the \`Implementation Steps\` section in order. Run the test command listed in the plan's \`Test Verification\` section, confirm the tests pass, and include the passing output in your final message.

# Approved Green-Phase Plan

${plan}

# Issue

${renderIssueBlock(issue)}

# Red-phase diff (DO NOT modify these test files)

\`\`\`diff
${redDiff}
\`\`\`

> **Recovery note:** If the working tree is already dirty when this phase starts, a previous session may have left partial work on disk. Inspect the current state (\`git status\`, \`git diff\`), continue where the previous session left off, and finish the implementation before signaling completion.

Rules:
- Do NOT modify, delete, or weaken any test file added in the red phase (see diff above for the exact list of test files and their contents)
- Do NOT add \`skip\`, \`xfail\`, \`pending\`, \`todo\`, \`xit\`, \`it.skip\`, or any other marker that suppresses a test or its assertions
- If a test seems wrong, surface it to the user instead of changing it
- Follow the plan closely; if you discover the plan is wrong or incomplete, ask the user for clarification
- If the tests are fundamentally unsolvable — wrong semantics, impossible contract, or a nonexistent API that cannot be created within scope — call \`bail_out\` with a precise diagnosis explaining exactly why the tests cannot be satisfied. After calling \`bail_out\`, send your final message summarizing the diagnosis and stop immediately. Do not attempt further edits.
`;
}

/**
 * System prompt for the merge-repair agent (§9 of plan_merge_flow.md).
 *
 * The agent runs in the staging worktree after a failed merge or post-merge
 * test failure. It must resolve the problem by adding new commits — no
 * amend/rebase/reset that drops commits from the worker's branch.
 */
export function buildMergeRepairSystemPrompt(
	issueId: number,
	title: string,
	testCommand: string,
): string {
	return `You are repairing a merge of issue #${issueId}: "${title}". The merge has been attempted in your working directory. Conflicts and/or test failures are described below. Resolve them so that \`${testCommand}\` passes on the merged tree.

Constraints:
- Do not rewrite the worker's commits. No \`git commit --amend\`, no \`git rebase\`, no \`git reset\` that drops commits.
- Make new commits on top of the in-progress merge as needed.
- Success requires a clean worktree and committed repair output. Uncommitted edits, staged-but-uncommitted changes, untracked files, or unresolved conflict paths are treated as repair failure, even if \`${testCommand}\` passes.
- If the work cannot be made to merge cleanly without rewriting history or making unrelated changes, call \`bail_out\` with a one-paragraph diagnosis. The issue will move to \`merge_failed\` and a human will take over.

Tools: read, grep, find, ls, bash, edit, write, bail_out.

After calling \`bail_out\`, send your final diagnostic message and stop immediately. Do not attempt further edits or tool calls after \`bail_out\`.
`;
}
