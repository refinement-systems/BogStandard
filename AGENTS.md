# BogStandard

BogStandard is an agent orchestrator built around two durable roles:

- **worker** — runs `/bs-task`, plans and implements one issue, then publishes the result for merge. Workers do not land changes on `main` themselves.
- **merger** — `bs-merge-worker`, validates queued work and lands it on `main`, transitioning the issue to `done`.

Issues live in a managed Postgres database. A [pi](https://github.com/earendil-works/pi) extension exposes the worker role via `/bs-task`, plus a conversational Designer (`/bs-design`) for brainstorming and creating new issues (create, update, comment, block, unblock, archive). The Designer never closes issues; closing belongs to the merger.

The normal one-issue flow is `bs-run` — a thin wrapper that runs one worker task in pi (with auto-shutdown at terminal boundaries) and then runs the merge worker once. For multiple parallel workers, use `dispatch.sh` plus a separate long-running `bs-merge-worker`.

## One-time setup

Install BogStandard once, inside its own checkout:

```bash
cd /path/to/BogStandard
npm install
```

Then, from any target project (no `package.json` required), run the wrapper:

```bash
cd /path/to/your-project
/path/to/BogStandard/bin/bs-setup --database-url postgres://localhost:5432/bogstandard_myproject
```

(Or put `BogStandard/bin` on your `PATH` and just say `bs-setup …`.)

The wrapper creates the database if missing, runs `db/migrations/0001_init.sql`, and writes `.bogstandard/config.json` in the target project's directory — not in BogStandard's checkout. Make sure your target project gitignores `.bogstandard/`. The extension and scripts all read this file by default; flags and env vars override individual fields:

| Source | Field | Notes |
|---|---|---|
| `--bs-database-url <url>` | `database_url` | Highest precedence |
| `BOGSTANDARD_DATABASE_URL` | `database_url` | Env override |
| `--bs-agent-id <id>` | `agent_id` | Per-invocation |
| `BOGSTANDARD_AGENT_ID` | `agent_id` | Env override |
| `.bogstandard/config.json` | `database_url`, `agent_id`, `stale_lock_timeout_minutes` | Default for the project |

## Importing from an existing chainlink project

From the target project's directory:

```bash
/path/to/BogStandard/bin/bs-import          # defaults to ./.chainlink/issues.db
```

Copies issues, comments, dependencies, and the `agent.json` agent id into the new Postgres database. Refuses to run against a non-empty target unless `--force` is passed. This is a one-shot data import; for schema migrations see below.

## Applying schema migrations

When pulling a BogStandard update that adds new files under `db/migrations/`, bring the existing database up to date from the target project's directory:

```bash
/path/to/BogStandard/bin/bs-migrate         # uses .bogstandard/config.json
```

This runs `node-pg-migrate` against the configured database, recording applied migrations in the `pgmigrations` table. Databases created before commit `61b2df3` have no `pgmigrations` table; the first run will create it and treat `0001_init` as a no-op via `CREATE TABLE IF NOT EXISTS`, then apply any newer migrations.

`bs-migrate` does not create the database — run `bs-setup` first for a new project.

## Running the workflow

The single-shot wrapper is the normal "work one issue" entry point:

```bash
bs-run                                                # next eligible issue
bs-run 42                                             # explicit issue id
bs-run -- --bs-plan-model openrouter/deepseek/deepseek-v4-flash
bs-run 42 -- --bs-impl-model anthropic/claude-sonnet-4-6
```

`bs-run` runs `/bs-task` inside an interactive pi session with `--bs-single-shot` set. When the worker reaches a terminal boundary (work queued for merge, issue closed without changes, no eligible issue, user abort, etc.) the extension calls `ctx.shutdown()` and pi exits; the wrapper then runs `bs-merge-worker --once` to land any queued merge.

Brainstorm issues via the Designer:

```bash
pi -e ./agent/extensions/bogstandard /bs-design
```

**`/bs-design`** runs a conversational Designer agent with a tool surface limited to issue CRUD: `list_issues`, `show_issue`, `draft_issue`, `update_issue`, `redraft_issue`, `add_comment`, `block`, `unblock`, `archive`. It is stateless across pi sessions — re-run any time to continue brainstorming. The Designer does not modify source files, run git, or close issues.

Issue hierarchy is expressed entirely through the block graph (`dependencies`): if issue B should wait for issue A, call `block(blocked_id=B, blocker_id=A)`. There is no separate parent/subissue relation. `block` rejects edges that would close a cycle (recursive-CTE check); the picker re-checks for cycles whenever it returns no eligible issues and surfaces the offending ids.

**`/bs-task` auto-pick** selects the first open issue with no open blockers, sorted by priority (critical → high → medium → low) then by id. The issue review screen lets you continue, add a comment, switch to a different issue, or abort.

**`/bs-task` with an explicit issue id** skips the auto-pick and goes straight to review for that issue.

`/bs-task` worker completion does **not** close changed issues directly: it commits to a worker branch, publishes `refs/bogstandard/issue-<id>`, records the handoff in `issue_branches`, transitions the issue to `merging_pending`, and enqueues a merge task. The merger closes issues by transitioning merge phases to `done` after a clean test run on `main`. The no-change path (no files changed) still transitions directly to `done` because there is nothing to merge.

For interactive debugging without auto-merge, call `/bs-task` directly:

```bash
pi -e ./agent/extensions/bogstandard /bs-task
pi -e ./agent/extensions/bogstandard /bs-task 42
```

Workers run this way stay in interactive pi when the task finishes; you can run another command in the same session.

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
   /bs-task
```

Flag format: `provider/model-id`, e.g. `openrouter/deepseek/deepseek-v4-flash` or `anthropic/claude-sonnet-4-6`. The broad flags (`--bs-plan-model`, `--bs-impl-model`) apply to all planning or implementation phases; the per-sub-phase flags override them when set.

### Resuming after a crash

```bash
pi -r -e ./agent/extensions/bogstandard
```

`pi -r` resumes the last session. The extension restores phase state from `pi.appendEntry` records and reconnects to the in-progress issue.

## Multi-worker dispatch

`./dispatch.sh [N]` creates N git worktrees off `main`, writes a per-worktree `.bogstandard/config.json` with a distinct `agent_id` (`worker-1`, `worker-2`, …), and starts a pi session in each — all pointing at the same postgres database. Per-worker `agent_id`s let each session hold its own locks (one row per issue in the `locks` table).

```bash
./dispatch.sh 3 -- --bs-plan-model openrouter/deepseek/deepseek-v4-flash
./dispatch.sh --cleanup    # tear down worktrees + branches
```

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

Runs unit tests covering the pure-logic modules:
- `phases.ts` — state loading/saving and all phase transitions
- `issue-picker.ts` — eligibility SQL, row mapping, `FIND_CYCLE_SQL` shape, and `findBlockCycleWith` (against query-runner stubs)
- `prompts.ts` — all six prompt builders (no-tests, red plan, red impl, green plan, green impl)
- `db.ts` — `buildIssueDisplay` formatting and `isLockStale` boundary checks
- `dependency-cycle.ts` — `CYCLE_CHECK_SQL` shape (parameter direction, recursive walk, LIMIT)
- `config.ts` — flag → env → file precedence
- `phases.ts` (interrupt) — `endReason` session stop-reason detection
- `scroll-math.ts` — scrollable-markdown viewer offset/page clamping

## Project structure

```
bin/
  bs-setup                     # Wrapper: run setup.ts against the caller's cwd
  bs-migrate                   # Wrapper: apply pending schema migrations
  bs-import                    # Wrapper: one-shot chainlink → postgres data import
  bs-list-eligible             # Wrapper: print eligible issue ids for the caller's cwd
  bs-merge-worker              # Wrapper: run the merge daemon against the configured DB
  bs-run                       # Single-shot orchestrator: one worker task, then one merge run
db/
  migrations/
    0001_init.sql              # Initial postgres schema
    0002_draft_status.sql      # Add 'draft' to issues.status check constraint
    0003_phase_state_and_versioning.sql  # Issue-centric phase machine + issue_versions
    0004_drop_parent_id.sql    # Collapse parent_id into dependencies; verify acyclic
    0005_merge_phases.sql      # Merge-flow phases + issue_branches handoff table
    0006_merge_queue.sql       # merge_tasks + merge_task_steps for the merge daemon
scripts/
  setup.ts                     # Create DB if missing, apply schema, write config.json
  migrate.ts                   # Apply pending node-pg-migrate migrations
  import-from-chainlink.ts     # Copy issues/comments/dependencies from .chainlink/issues.db
  list-eligible.ts             # Print eligible issue ids (used by dispatch.sh)
  run-merge-worker.ts          # bs-merge-worker daemon: claim, run, finalize merges
  lib/
    migrations.ts              # Shared node-pg-migrate runner used by setup.ts + migrate.ts
    merge-runtime.ts           # Daemon-side queue runtime: runOnce/runDaemon + step replay
    merge-worker.ts             # Staging worktree + merge config helpers
    agent-runner.ts            # Shared agent loop wrapper used by run-merge-worker
agent/
  extensions/
    bogstandard/               # The pi extension (TypeScript)
      index.ts                   # Extension factory: /bs-task command, event handlers
      designer.ts                # /bs-design command + Designer tools (create/update/block/etc.)
      designer-prompts.ts        # Designer system prompt + kickoff message
      config.ts                  # Flag/env/file config resolution
      db.ts                      # Postgres adapter (issue CRUD, ownership, dependencies + CYCLE_CHECK_SQL guard)
      git.ts                     # Typed wrappers over pi.exec("git", ...)
      issue-picker.ts            # Eligibility query, FIND_CYCLE_SQL, findBlockCycle diagnostic, label formatting
      merge-handoff.ts           # Worker → daemon handoff (issue_branches + enqueueMergeTask)
      merge-queue.ts             # Schema-touching helpers for merge_tasks (enqueue, row types)
      phases.ts                  # /bs-task phase state types, loadState / saveState
      prompts.ts                 # All /bs-task + merge prompt builders (inline content, no temp files)
      questionnaire.ts           # Questionnaire tool for plan-phase clarifying questions
      scrollable-markdown.ts     # ScrollableMarkdownView component used by issue + plan review
      scroll-math.ts             # Pure scroll-offset helpers (testable without pi runtime)
      single-shot.ts             # Pure shouldShutdownInSingleShot helper used by --bs-single-shot
reference/                     # Not tracked; open-source reference code
draft/                         # Not checked out; implementation reference snippets
tests/
  run.sh                         # Thin wrapper that runs npm test
  phases.test.ts                 # Unit tests for phase state
  interrupt.test.ts              # Unit tests for endReason (session stop detection)
  issue-picker.test.ts           # Unit tests for the eligibility query + sorting
  prompts.test.ts                # Unit tests for prompt builders
  db.test.ts                     # Unit tests for buildIssueDisplay + isLockStale
  config.test.ts                 # Unit tests for config precedence
  scroll-math.test.ts            # Unit tests for scroll-offset helpers
  designer.test.ts               # Unit tests for assertPriority + Designer prompt builders
  dependency-cycle.test.ts       # Unit tests for CYCLE_CHECK_SQL shape
  single-shot.test.ts            # Unit tests for shouldShutdownInSingleShot
  bs-run.test.ts                 # Integration tests for bin/bs-run with fake pi + merger
package.json                   # vitest + pg + better-sqlite3 + tsx
dispatch.sh                    # Multi-worker dispatcher (postgres-backed)
vitest.config.ts
tsconfig.json                  # For IDE type checking (noEmit)
spec/
  tla/
    BogStandard.tla            # TLA+ spec of the /bs-task phase state machine
    BogStandard.cfg            # TLC invariant configuration
tools/
  macos/
    find-tla-tools.sh          # Sourced helper: exports TLA_TOOLS and JAVA
    tla-check.sh               # Syntax checker (SANY)
    tla-model-check.sh         # Model checker (TLC)
```

## TLA+ specification

`spec/tla/BogStandard.tla` models the `/bs-task` phase machine across N
concurrent workers, plus an abstract per-issue git state. The v1 model
covers the nine DB phases from `db.ts:66-77` (drafting and archived are
out of scope — issues are born `ready`), the conditional-UPDATE
transition pattern in `transitionPhase`, claim-on-ownership, the TDD
red/green/bail loop, and the eligibility predicate from
`issue-picker.ts`.

Default config: two workers, two issues (`i1` no-tests, `i2` TDD), `i1`
blocks `i2`, `MAX_BAILS = 2`. With the bug-exhibit invariant disabled
(see below), the spec has 41 reachable states at depth 19; TLC finishes
in about a second.

### Safety invariants

- `TypeOK`, `MutualExclusion`, `OneIssuePerWorker`, `PhaseShapeOK`,
  `BailBound` — sanity checks; all hold.
- `MergeSoundness` — **intentionally fails on v1.** It documents the
  `dispatch.sh` + `closeAndCommit` bug: workers commit to per-worktree
  branches and mark issues `done` without ever merging back to `main`,
  so a downstream worker can plan an issue whose blocker's code is
  still on an unmerged branch. The expected six-step counterexample is
  `Claim(w1,i1) → StartPlanning → CompletePlanning → CompleteImpl →
  Claim(w1,i2) → StartPlanning(i2)` — at which point i2 is in
  `red_planning` while `main_committed = {}` even though i1 is `done`.

### Out of scope for v1, planned for v2

- An explicit `merging` phase between `*_impl` and `done`, plus a
  `Merge` action that advances `main_committed`. This is the proposed
  fix; running TLC against v2 should show `MergeSoundness` passing.
- `Steal` (db.ts:1007) and release-without-completion paths.
- `work_state ∈ {NoWork, OnBranch, OnMain}` per issue and `branch_base`
  per worker, for conflict-aware reasoning about merges.

## macOS tools

`tools/macos/` contains shell scripts that drive the TLA+ Toolbox's bundled
Java and tools jar. The system-wide `java` stub does not work with TLC/SANY.

- `find-tla-tools.sh` — source this in other scripts; exports `TLA_TOOLS`
  (path to `org.lamport.tlatools_*` plugin) and `JAVA` (bundled java binary).
  Fails fast if the Toolbox is not installed at `/Applications/TLA+ Toolbox.app`.
- `tla-check.sh <spec.tla>` — syntax checker (SANY); cds to the spec directory
  before invoking so TLA+ can resolve module names.
- `tla-model-check.sh <spec.tla> [config.cfg]` — model checker (TLC); config
  defaults to `<spec-base>.cfg` in the same directory as the spec.

Quick start from the repo root:

```bash
tools/macos/tla-check.sh       spec/tla/BogStandard.tla
tools/macos/tla-model-check.sh spec/tla/BogStandard.tla
```
