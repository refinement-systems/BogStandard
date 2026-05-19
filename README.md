# BogStandard

The swamp level of agent orchestrators.

# Structure

BogStandard is a pi extension and an orchestrator script.

* The extension automates a two-phase `plan → implement` loop for issues stored in a managed Postgres database. It runs as a [pi](https://github.com/earendil-works/pi) extension: a single `/bogstandard` command drives issue review, planning (with interactive refinement), optional TDD red/green cycle, implementation, issue close, and git commit — all within one pi session.
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
