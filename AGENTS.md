# BogStandard

BogStandard automates a two-phase plan→implement loop for issues tracked in a managed Postgres database. It runs as a [pi](https://github.com/earendil-works/pi) extension exposing two commands:

- `/bs-task` drives the full plan→implement flow — issue review, planning, optional TDD red/green cycle, implementation, issue close, and git commit — all within one pi session.
- `/bs-design` opens a separate conversational Designer session for brainstorming and creating new issues (create, update, comment, block, subissue, reparent, archive). The Designer never closes issues; closing belongs to `/bs-task`.

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

Load the extension with `-e` and invoke either command:

```bash
# Brainstorm and create new issues
pi -e ./agent/extensions/bogstandard /bs-design

# Auto-pick the next eligible open issue and work it end-to-end
pi -e ./agent/extensions/bogstandard /bs-task

# Explicit issue number
pi -e ./agent/extensions/bogstandard /bs-task 42
```

**`/bs-design`** runs a conversational Designer agent with a tool surface limited to issue CRUD: `list_issues`, `show_issue`, `create_issue`, `create_subissue`, `update_issue`, `add_comment`, `block`, `unblock`, `reparent`, `archive`. It is stateless across pi sessions — re-run any time to continue brainstorming. The Designer does not modify source files, run git, or close issues.

**`/bs-task` auto-pick** selects the first open issue with no open subissues and no open blockers, sorted by priority (critical → high → medium → low) then by id. The issue review screen lets you continue, add a comment, switch to a different issue, or abort.

**`/bs-task` with an explicit issue id** skips the auto-pick and goes straight to review for that issue.

Both `/bs-task` paths end with closing the issue (`UPDATE issues SET status='closed'`) and creating a git commit. Closing an issue no longer touches CHANGELOG.md — only the git commit message reflects the change.

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
- `issue-picker.ts` — eligibility SQL and row mapping (against a query-runner stub)
- `prompts.ts` — all six prompt builders (no-tests, red plan, red impl, green plan, green impl)
- `db.ts` — `buildIssueDisplay` formatting and `isLockStale` boundary checks
- `config.ts` — flag → env → file precedence
- `phases.ts` (interrupt) — `endReason` session stop-reason detection
- `scroll-math.ts` — scrollable-markdown viewer offset/page clamping

SQL-touching paths (the eligibility query against a real database, lock claim/release/steal, comment insertion, issue close) are exercised manually via end-to-end smoke runs; the unit suite uses stub runners and pure helpers.

## Project structure

```
bin/
  bs-setup                     # Wrapper: run setup.ts against the caller's cwd
  bs-migrate                   # Wrapper: apply pending schema migrations
  bs-import                    # Wrapper: one-shot chainlink → postgres data import
  bs-list-eligible             # Wrapper: print eligible issue ids for the caller's cwd
db/
  migrations/
    0001_init.sql              # Initial postgres schema
    0002_draft_status.sql      # Add 'draft' to issues.status check constraint
scripts/
  setup.ts                     # Create DB if missing, apply schema, write config.json
  migrate.ts                   # Apply pending node-pg-migrate migrations
  import-from-chainlink.ts     # Copy issues/comments/dependencies from .chainlink/issues.db
  list-eligible.ts             # Print eligible issue ids (used by dispatch.sh)
  lib/
    migrations.ts              # Shared node-pg-migrate runner used by setup.ts + migrate.ts
agent/
  extensions/
    bogstandard/               # The pi extension (TypeScript)
      index.ts                   # Extension factory: /bs-task command, event handlers
      designer.ts                # /bs-design command + Designer tools (create/update/block/etc.)
      designer-prompts.ts        # Designer system prompt + kickoff message
      config.ts                  # Flag/env/file config resolution
      db.ts                      # Postgres adapter (issue CRUD, locks, dependencies)
      git.ts                     # Typed wrappers over pi.exec("git", ...)
      issue-picker.ts            # Eligibility query (single SQL) + label formatting
      phases.ts                  # /bs-task phase state types, loadState / saveState
      prompts.ts                 # All six /bs-task prompt builders (inline content, no temp files)
      questionnaire.ts           # Questionnaire tool for plan-phase clarifying questions
      scrollable-markdown.ts     # ScrollableMarkdownView component used by issue + plan review
      scroll-math.ts             # Pure scroll-offset helpers (testable without pi runtime)
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
package.json                   # vitest + pg + better-sqlite3 + tsx
dispatch.sh                    # Multi-worker dispatcher (postgres-backed)
vitest.config.ts
tsconfig.json                  # For IDE type checking (noEmit)
```
