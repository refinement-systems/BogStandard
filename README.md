# BogStandard

The swamp level of agent orchestrators.

# Structure

BogStandard is a pi extension and an orchestrator script.

* The extension automates a two-phase `plan → implement` loop for Chainlink issues. It runs as a [pi](https://github.com/earendil-works/pi) extension: a single `/bogstandard` command drives issue review, planning (with interactive refinement), optional TDD red/green cycle, implementation, issue close, and git commit — all within one pi session.
* The script runs multiple sessions in parallel, picking the appropriate issues.

NOTE: while the extension is okay-ish, the dispatch.sh is very WIP and should not be used for any valuable projects.

## Requirements

- [`pi`](https://github.com/earendil-works/pi) (the coding agent)
- `chainlink`
- `git`

## Usage

Run from inside a chainlink-initialized git repo:

```bash
# Auto-pick the next eligible open issue
pi -e /path/to/BogStandard/agent/extensions/bogstandard /bogstandard

# Explicit issue number
pi -e /path/to/BogStandard/agent/extensions/bogstandard /bogstandard 42
```

If you're running from the repo root, use a relative path:

```bash
pi -e ./agent/extensions/bogstandard /bogstandard
```

### Issue selection

**Auto-pick** (no argument) selects the first open issue with no open subissues and no open blockers, sorted by priority (critical → high → medium → low) then by id ascending. The issue review screen lets you continue, add a comment, switch to a different issue, or abort.

**Explicit issue** (numeric argument) skips auto-pick and goes straight to review.

### Planning and refinement

The planner agent explores the repo, asks clarifying questions via the `questionnaire` tool if needed, and submits the plan via `save_plan`. An editor then opens with the plan prefilled:

- **Submit** — accepts the plan and moves to implementation.
- **Escape** — prompts for refinement instructions, re-enters the planner in the same session, then reopens the editor. Repeat until satisfied.

### TDD path

Answering "Yes" to "Does this issue need tests?" enables a red/green TDD cycle:

1. **Red plan + implement** — writes failing tests, commits as `"Testing phase: red"`.
2. **Green plan + implement** — makes the tests pass without modifying them.
3. **Bail** — if the green agent calls `bail_out`, BogStandard posts a diagnosis comment, rolls back the red commit, and restarts at the red planner with the updated issue context.

Requires a clean working tree before the red phase starts.

### Per-phase model selection

```bash
pi -e ./agent/extensions/bogstandard \
   --bs-plan-model       openrouter/deepseek/deepseek-v4-flash \
   --bs-impl-model       anthropic/claude-opus-4-7 \
   --bs-red-plan-model   openrouter/deepseek/deepseek-v4-flash \
   --bs-green-impl-model anthropic/claude-opus-4-7 \
   /bogstandard
```

| Flag | Applies to |
|---|---|
| `--bs-plan-model` | All planning phases (overridden by per-phase flags) |
| `--bs-impl-model` | All implementation phases (overridden by per-phase flags) |
| `--bs-red-plan-model` | Red-phase planner only |
| `--bs-red-impl-model` | Red-phase implementer only |
| `--bs-green-plan-model` | Green-phase planner only |
| `--bs-green-impl-model` | Green-phase implementer only |

Flag format: `provider/model-id`. For OpenRouter models use `openrouter/` as prefix: `openrouter/deepseek/deepseek-v4-flash`. Set `OPENROUTER_API_KEY` in your environment so pi can authenticate.

### Crash recovery / resume

```bash
pi -r -e ./agent/extensions/bogstandard
```

`pi -r` resumes the last session. The extension restores phase state and reconnects to the in-progress issue.

## Running the tests

```bash
./tests/run.sh
# equivalent:
npm test
```

102 unit tests covering `phases.ts`, `issue-picker.ts`, `prompts.ts`, `chainlink.ts`, and interrupt detection.

## Development

Clone the repo and run tests directly:

```bash
git clone <repo-url> BogStandard
cd BogStandard
npm install
npm test
```

Run the extension from the repo root against any chainlink-initialized project:

```bash
pi -e ./agent/extensions/bogstandard /bogstandard
```

See [AGENTS.md](AGENTS.md) for architecture details, phase descriptions, and project structure.
