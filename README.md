# BogStandard

The swamp level of agent orchestrators.

# Structure

BogStandard is a pi extension and an orchestrator script.

* The extension automates a two-phase `plan → implement` loop for issues stored in a managed Postgres database. It runs as a [pi](https://github.com/earendil-works/pi) extension exposing two commands:
  * `/bs-task` drives issue review, planning (with interactive refinement), optional TDD red/green cycle, implementation, issue close, and git commit — all within one pi session.
  * `/bs-design` opens a conversational Designer session for brainstorming and seeding new issues into the database (create, update, block, subissue, archive — but not close, since that belongs to `/bs-task`).
* The script runs multiple sessions in parallel, picking the appropriate issues.

NOTE: while the extension is okay-ish, the dispatch.sh is very WIP and should not be used for any valuable projects.

## Requirements

- [`pi`](https://github.com/earendil-works/pi) (the coding agent)
- `git`
- A reachable PostgreSQL server (local or remote)
- Node.js 20+

## Install BogStandard

You install BogStandard *once*, in its own checkout — target projects don't need their own `package.json` or `npm install`. From this repo's root:

```bash
npm install
```

Optionally put BogStandard's `bin/` directory on your `PATH` so the wrappers below are reachable by short name:

```bash
export PATH="/path/to/BogStandard/bin:$PATH"
```

If you prefer not to extend `PATH`, call the wrappers by absolute path (`/path/to/BogStandard/bin/bs-setup …`).

## Set up a target project

`cd` into your target project (it does not need to be JavaScript or have a `package.json`) and run:

```bash
bs-setup --database-url postgres://localhost:5432/bogstandard_myproject
```

This creates the database if it doesn't already exist, applies the schema (`db/migrations/0001_init.sql`), and writes `.bogstandard/config.json` in the **target project's** directory with the connection string and a default `agent_id`. Make sure `.bogstandard/` is gitignored in your target project (or in your global gitignore).

If the target project previously used chainlink, migrate the existing data:

```bash
bs-migrate           # reads ./.chainlink/issues.db, writes to your postgres DB
```

The chainlink CLI and its `.chainlink/` directory are no longer used after migration.

## Configuration

The extension and scripts read `.bogstandard/config.json` for the postgres connection. Overrides, highest precedence first:

1. CLI flags: `--bs-database-url <url>`, `--bs-agent-id <id>`
2. Env vars: `BOGSTANDARD_DATABASE_URL`, `BOGSTANDARD_AGENT_ID`
3. `.bogstandard/config.json`

## Usage

Run from inside a project that has been set up:

```bash
# Brainstorm and create new issues with the Designer
pi -e /path/to/BogStandard/agent/extensions/bogstandard /bs-design

# Auto-pick the next eligible open issue
pi -e /path/to/BogStandard/agent/extensions/bogstandard /bs-task

# Explicit issue number
pi -e /path/to/BogStandard/agent/extensions/bogstandard /bs-task 42
```

If you're running from the repo root, use a relative path:

```bash
pi -e ./agent/extensions/bogstandard /bs-task
```

### Designer (`/bs-design`)

`/bs-design` opens a conversational session for filling the backlog. The agent has read-only access to the codebase plus a tool set scoped to issue creation and refinement: `list_issues`, `show_issue`, `create_issue`, `create_subissue`, `update_issue`, `add_comment`, `block`, `unblock`, `reparent`, and `archive`. Closing and reopening are intentionally absent — those belong to `/bs-task`. The Designer is stateless across sessions; re-run `/bs-design` any time to keep brainstorming.

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
   --bs-plan-model       openrouter/deepseek/deepseek-v4-pro \
   --bs-impl-model       openrouter/deepseek/deepseek-v4-flash \
   --bs-red-plan-model   openrouter/deepseek/deepseek-v4-pro \
   --bs-green-impl-model openrouter/deepseek/deepseek-v4-flash \
   /bs-task
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

## Multi-worker dispatch

`dispatch.sh` spawns N parallel BogStandard workers, each in its own git worktree off `main` and its own tmux window, all pointing at the same postgres database. Each worktree gets a per-worker `.bogstandard/config.json` whose `agent_id` is set to `worker-1`, `worker-2`, … so the `locks` table can hold one row per concurrent worker without collisions.

> Heads up: `dispatch.sh` is still rough — fine for this repo and toys, but don't aim it at anything you care about yet.

Prereqs: `bs-setup` has already been run in this repo (so `.bogstandard/config.json` exists), and `tmux` is on `PATH`.

```bash
./dispatch.sh                    # 2 workers (default)
./dispatch.sh 4                  # 4 workers
./dispatch.sh 3 -- --bs-plan-model openrouter/deepseek/deepseek-v4-flash
./dispatch.sh --cleanup          # remove worker worktrees + branches
```

Anything after `--` is forwarded verbatim to every `pi` invocation. The dispatcher reads eligible issue ids via `bs-list-eligible` and pre-assigns one to each worker with `--bs-issue-id`, so workers don't race on auto-pick.

Workers run inside a tmux session named `bogstandard-dispatch-<pid>`. Detach with `Ctrl-b d`, re-attach with `tmux attach -t bogstandard-dispatch-<pid>`. When you're done, `./dispatch.sh --cleanup` removes the `bogstandard/worker-*` branches and their worktrees.

## Inspecting the database

There's no admin UI yet — during this early stage of the project, `psql` is the debugger. Connect using the URL from `.bogstandard/config.json`:

```bash
psql "$(node -e "console.log(JSON.parse(require('fs').readFileSync('.bogstandard/config.json','utf8')).database_url)")"
```

A small cookbook against the schema in `db/migrations/0001_init.sql`:

**All open issues, ordered by priority then id**

```sql
SELECT id, priority, title
  FROM issues
 WHERE status = 'open'
 ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium'   THEN 2 WHEN 'low'  THEN 3 ELSE 4 END,
          id;
```

**Ready / eligible issues** — open, no open subissues, no open blockers. This is the same query the auto-picker and `bs-list-eligible` use (see `ELIGIBLE_SQL` in `agent/extensions/bogstandard/issue-picker.ts`), so the result should match `bs-list-eligible` exactly:

```sql
SELECT i.id, i.title, i.priority, i.status
  FROM issues i
 WHERE i.status = 'open'
   AND NOT EXISTS (
         SELECT 1
           FROM dependencies d
           JOIN issues b ON d.blocker_id = b.id
          WHERE d.blocked_id = i.id AND b.status = 'open')
   AND NOT EXISTS (
         SELECT 1
           FROM issues s
          WHERE s.parent_id = i.id AND s.status = 'open')
 ORDER BY CASE i.priority
            WHEN 'critical' THEN 0
            WHEN 'high'     THEN 1
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 3
            ELSE 4
          END, i.id;
```

**Blocked issues with their open blockers**

```sql
SELECT i.id AS blocked, i.title, b.id AS blocker, b.title AS blocker_title
  FROM issues i
  JOIN dependencies d ON d.blocked_id = i.id
  JOIN issues b ON d.blocker_id = b.id
 WHERE i.status = 'open' AND b.status = 'open'
 ORDER BY i.id;
```

**Open issues that still have open subissues**

```sql
SELECT p.id, p.title, COUNT(s.id) AS open_subissues
  FROM issues p
  JOIN issues s ON s.parent_id = p.id
 WHERE p.status = 'open' AND s.status = 'open'
 GROUP BY p.id, p.title
 ORDER BY p.id;
```

**Currently held locks — which worker is on what**

```sql
SELECT l.issue_id, l.agent_id, l.branch, l.claimed_at, i.title
  FROM locks l
  JOIN issues i ON i.id = l.issue_id
 ORDER BY l.claimed_at;
```

**Recent comments on a given issue**

```sql
SELECT id, kind, created_at, left(content, 80) AS preview
  FROM comments
 WHERE issue_id = 42
 ORDER BY created_at DESC;
```

**Counts by status and priority** — quick gut check on the backlog shape:

```sql
SELECT status, priority, count(*)
  FROM issues
 GROUP BY status, priority
 ORDER BY status, priority;
```

Notes on the other tables: `agent_config` is a single-row table holding the project-wide agent id and description. `locks` rows are released when an issue is completed; the `stale_lock_timeout_minutes` value in `.bogstandard/config.json` is the cutoff after which another worker may steal an apparently abandoned lock.

## Running the tests

```bash
./tests/run.sh
# equivalent:
npm test
```

Unit tests cover `phases.ts`, `issue-picker.ts`, `prompts.ts`, `db.ts`, `config.ts`, and interrupt detection.

## Development

Hacking on BogStandard itself (not just using it):

```bash
git clone <repo-url> BogStandard
cd BogStandard
npm install
npm test
```

See [AGENTS.md](AGENTS.md) for architecture details, phase descriptions, and project structure.
