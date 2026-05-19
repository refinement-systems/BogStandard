# BogStandard

BogStandard automates a two-phase plan→implement loop for Chainlink issues. It runs as a [pi](https://github.com/earendil-works/pi) extension: a single `/bogstandard` command drives the full flow — issue review, planning, optional TDD red/green cycle, implementation, issue close, and git commit — all within one pi session.

## Running the workflow

Load the extension with `-e` and invoke the `/bogstandard` command:

```bash
# Auto-pick the next eligible open issue
pi -e ./agent/extensions/bogstandard /bogstandard

# Explicit issue number
pi -e ./agent/extensions/bogstandard /bogstandard 42
```

**Auto-pick** selects the first open issue with no open subissues and no open blockers, sorted by priority (critical → high → medium → low) then by id. The issue review screen lets you continue, add a comment, switch to a different issue, or abort.

**Explicit issue** skips the auto-pick and goes straight to review for that issue.

Both paths end with closing the issue and creating a git commit.

### Planning and plan review

After issue review, the planner agent runs with read-only tools (`read`, `grep`, `find`, `ls`, `bash`) plus `questionnaire` (for clarifying questions) and `save_plan` (to submit the plan). When the planner calls `save_plan`, a scrollable plan viewer opens:

- **↵ accept** — moves to implementation.
- **Escape** — drops to a "Send instructions / Abort" prompt. Your instructions re-enter the planner in the same session, then the viewer reopens. Repeat until satisfied.

### TDD path

When you answer "Yes" to "Does this issue need tests?", BogStandard runs a red/green TDD cycle instead of the single-pass no-tests flow:

1. **Red planner** — writes a plan for failing tests.
2. **Red implementer** — writes the tests and confirms they fail. Commits as `"Testing phase: red"`.
3. **Green planner** — writes a production-code plan to make the tests pass (red diff is inlined).
4. **Green implementer** — makes the tests pass. Can call `bail_out` if the tests are unsatisfiable.
5. On bail: posts a diagnosis comment, resets the red commit, and restarts at the red planner with the updated issue context.

The TDD path requires a clean working tree before the red planner starts.

### Per-phase model selection

Each phase can use a different model:

```bash
pi -e ./agent/extensions/bogstandard \
   --bs-plan-model     openrouter/deepseek/deepseek-v4-flash \
   --bs-impl-model     anthropic/claude-opus-4-7 \
   --bs-red-plan-model openrouter/deepseek/deepseek-v4-flash \
   --bs-green-impl-model anthropic/claude-opus-4-7 \
   /bogstandard
```

Flag format: `provider/model-id`, e.g. `openrouter/deepseek/deepseek-v4-flash` or `anthropic/claude-sonnet-4-6`. The broad flags (`--bs-plan-model`, `--bs-impl-model`) apply to all planning or implementation phases; the per-sub-phase flags override them when set.

### Resuming after a crash

```bash
pi -r -e ./agent/extensions/bogstandard
```

`pi -r` resumes the last session. The extension restores phase state from `pi.appendEntry` records and reconnects to the in-progress issue.

## Running under tmux

Pi emits a startup warning when `extended-keys` is off:

```
Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.
```

To suppress it, add these two lines to `~/.tmux.conf` and restart tmux:

```
set -g extended-keys on
set -g extended-keys-format csi-u
```

BogStandard only uses plain Enter, Escape, and single-letter keys, so it works correctly without this setting. The warning is about modified Enter variants (Ctrl+Enter, Shift+Enter, etc.) that BogStandard never binds.

## Running the tests

```bash
./tests/run.sh
# equivalent:
npm test
```

Runs 114 unit tests covering the pure-logic modules:
- `phases.ts` — state loading/saving and all phase transitions
- `issue-picker.ts` — eligibility filtering and priority/id sort order
- `prompts.ts` — all six prompt builders (no-tests, red plan, red impl, green plan, green impl)
- `chainlink.ts` — `buildIssueDisplay` formatting
- `phases.ts` (interrupt) — `endReason` session stop-reason detection
- `scroll-math.ts` — scrollable-markdown viewer offset/page clamping

End-to-end workflow testing (issue pick → plan → implement → commit) is done manually; the TUI-based review dialogs cannot be driven headlessly.

## Project structure

```
agent/
  extensions/
    bogstandard/               # The pi extension (TypeScript)
      index.ts                   # Extension factory: command, tools, event handlers
      chainlink.ts               # Typed wrappers over pi.exec("chainlink", ...)
      git.ts                     # Typed wrappers over pi.exec("git", ...)
      issue-picker.ts            # Port of pick_first_issue_id; eligibility + priority sort
      phases.ts                  # Phase state types, loadState / saveState
      prompts.ts                 # All six prompt builders (inline content, no temp files)
      questionnaire.ts           # Questionnaire tool for plan-phase clarifying questions
      scrollable-markdown.ts     # ScrollableMarkdownView component used by issue + plan review
      scroll-math.ts             # Pure scroll-offset helpers (testable without pi runtime)
reference/                     # Not tracked; open-source reference code
draft/                         # Not checked out; implementation reference snippets
tests/
  run.sh                         # Thin wrapper that runs npm test
  phases.test.ts                 # Unit tests for phase state
  interrupt.test.ts              # Unit tests for endReason (session stop detection)
  issue-picker.test.ts           # Unit tests for eligibility + sorting
  prompts.test.ts                # Unit tests for prompt builders
  chainlink.test.ts              # Unit tests for buildIssueDisplay
  scroll-math.test.ts            # Unit tests for scroll-offset helpers
package.json                   # vitest dev dependency
vitest.config.ts
tsconfig.json                  # For IDE type checking (noEmit)
```
