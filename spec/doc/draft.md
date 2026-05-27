# BogStandard — Plain-English Specification (DRAFT)

> **Status:** Draft. This document is derived from the TLA+ model in
> `spec/tla/BogStandard.tla` and the test suite in `tests/`, not from a
> close reading of the implementation. Where the two disagree (notably
> around the `Steal` action and `MainIsRedError`), the discrepancy is
> called out explicitly in §13. Each numbered "Contract" is intended to
> be traceable to either a TLA+ identifier or a specific test file.

## Table of contents

1. Purpose and scope
2. Roles
3. Data model
4. Issue lifecycle and the phase machine
5. Eligibility and blockers
6. Ownership and locking
7. Worker workflow (`/bs-task`)
8. Merge-daemon workflow (`bs-merge-worker`)
9. Designer (`/bs-design`)
10. Configuration, setup, import, migrations
11. Single-shot vs long-running modes
12. Safety invariants (lifted from TLA+)
13. Out of scope / known gaps
14. Glossary

---

## 1. Purpose and scope

BogStandard is an agent orchestrator. Given a Postgres database of
issues, it lets one or more autonomous agents claim issues, plan and
implement changes against a git working tree, hand off the result to
a separate merger, and arrive at a `done` issue on `main`. The split
between **worker** and **merger** is the central architectural choice:
workers never land on `main`; they publish a durable git ref, and a
single merger drains a queue of those refs against a clean staging
worktree, with its own pre/post-merge test cycle and a repair-agent
fallback for conflicts.

The system also includes a conversational **Designer** that brainstorms
issues but never modifies source and never closes issues.

### In scope for this document

- The full phase set and the legal transitions between phases.
- The eligibility rule used by the picker, including how blocker
  resolution interacts with merge-flow phases.
- The ownership/locking protocol (claim, release, steal, heartbeat).
- The worker's planning and implementation phases, the TDD red/green
  loop, the bail bound, and the no-changes close path.
- The merge daemon's claim/preflight/merge/repair/finalize sequence,
  the merge-task queue with its step-checkpoint replay, and the
  idempotency contracts on both ends of the handoff.
- The Designer's tool surface and the safety guarantees on it.
- Configuration precedence (flag/env/file/default), the setup flow,
  the chainlink import, and migration semantics.
- The difference between single-shot (`bs-run`) and long-running
  (`dispatch.sh`) modes.
- The safety invariants validated by TLC.

### Out of scope

- The pi runtime, including how event streams are routed and how
  resume works mechanically.
- The specific Claude/Anthropic SDK model selection logic and the
  per-phase model overrides beyond the fact that they exist.
- Concrete git conflict modelling, SHA arithmetic, and the binary
  shape of any diff.
- The MCP tool implementations beyond their named tool surfaces.
- The pre-`61b2df3` database upgrade path beyond the bootstrap
  guarantees made by `applyMigrations`.

---

## 2. Roles

| Role | Entry point | Closes issues? | Touches `main`? |
|---|---|---|---|
| Worker | `/bs-task` (inside pi) | Only via `no_change_closed` | No |
| Merger | `bs-merge-worker` (daemon) | Yes, on finalize | Yes (fast-forwards `refs/heads/main`) |
| Designer | `/bs-design` (inside pi) | **No** (forbidden) | No |
| `bs-run` wrapper | shell | Indirect (via worker + merger) | Indirect |
| `dispatch.sh` | shell | Indirect | Indirect |

**Contract 2.1 (worker).** A worker runs to one of a small set of
*terminal boundaries* (§7), each of which clears its ownership of the
current issue. It either hands off a durable ref to the merger or
closes the issue directly via the no-changes path; it does not, by
itself, advance `main`.

**Contract 2.2 (merger).** Only the merger advances `refs/heads/main`
and only the merger transitions issues from a merge-flow phase to
`done` (or `merge_failed`). The merger is single-consumer: tasks are
claimed `FOR UPDATE SKIP LOCKED` on `merge_tasks`. This is enforced
operationally by running one `bs-merge-worker` instance per database.

**Contract 2.3 (Designer).** The Designer is strictly an issue-CRUD
agent. Its system prompt explicitly states that *closing* is the
exclusive responsibility of `/bs-task`. Its tool surface excludes
git, file edits, and SQL.

---

## 3. Data model

This section enumerates the tables, their key constraints, the
relationships, and the invariants the tests pin down. Field types
follow Postgres conventions; bigint ids may be returned by the
`pg` driver as strings and are coerced to numbers by the codebase
(see `tests/db-crud.integration.test.ts`).

### 3.1 `issues`

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `phase` | text, CHECK constraint covers the full phase set in §4.1 |
| `priority` | text, CHECK in `{low, medium, high, critical}` |
| `current_version_id` | FK → `issue_versions.id`; nullable mid-insert only |
| `current_agent_id` | text, nullable. Owner of the claim |
| `phase_started_at` | timestamp; reset on every transition |
| `needs_tests` | boolean, **nullable** (legacy import rows and fresh drafts may be null) |
| `updated_at` | timestamp, bumped by every `issueUpdate` field-change |

**Contract 3.1.1 (mid-insert exclusion).** Any row with
`current_version_id IS NULL` is treated as "in flight" and excluded
from `issueList`. This is the only time an issue may have a null
version pointer.

**Contract 3.1.2 (priority enum).** Priority values outside the
four-element set are rejected by both `assertPriority` (JS guard) and
the column CHECK constraint. The enum has total order
`critical > high > medium > low`, used by the picker.

**Contract 3.1.3 (needs_tests).** Promotion from `drafting` to `ready`
requires `needs_tests` to be non-null. The picker also requires
`needs_tests IS NOT NULL` — chainlink-imported rows that are
`drafting` with null `needs_tests` are not eligible until classified.

**Contract 3.1.4 (phase_started_at).** Reset on *every* transition by
`transitionPhase`. Heartbeats via `appendPhaseEvent` do **not** touch
it. A null `phase_started_at` with a non-null `current_agent_id` is
treated by the picker as a "fresh claim" and excluded from
eligibility.

### 3.2 `issue_versions`

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `issue_id` | FK → `issues.id` ON DELETE CASCADE |
| `version_no` | int, monotone starting at 1; UNIQUE `(issue_id, version_no)` |
| `title` | text NOT NULL |
| `description` | text |
| `needs_tests` | boolean, may be null on v1 of legacy imports |
| `created_by` | text, defaults to caller's agent id |

**Contract 3.2.1 (monotone versions).** Version numbers never skip and
never repeat for a given issue. The UNIQUE constraint is the line of
defence against concurrent redrafts (see Contract 7.2.5).

**Contract 3.2.2 (current pointer).** `issues.current_version_id`
always points at exactly one row in `issue_versions` for that issue.
Redraft inserts v(n+1) and flips the pointer in the same transaction.

### 3.3 `comments`

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `issue_id` | FK → `issues.id` ON DELETE CASCADE |
| `version_id` | FK → `issue_versions.id` ON DELETE **SET NULL** (NOT NULL post-0003) |
| `kind` | text, e.g. `note`, `human`, `decision`, `observation`, `blocker`, `carry_forward`, `result`, `handoff`, `plan` |
| `content` | text |

**Contract 3.3.1 (version-scoped).** After migration 0003, every
comment has a non-null `version_id` referencing some version of the
parent issue. Comments do not migrate forward into new versions: a
redraft creates a new version with **no** carried comments except a
single `carry_forward` comment summarising prior context.

**Contract 3.3.2 (kind allow/blocklist for prompts).** Prompt builders
include comments of kinds `human`, `note`, `decision`, `observation`
and exclude `blocker`, `carry_forward`, `result`, `handoff`. The
allowlist is what reaches the agent; the blocklist exists so that
"machine-generated" notes don't leak back into a planner's context.

### 3.4 `dependencies`

| Column | Notes |
|---|---|
| `blocker_id` | FK → `issues.id` ON DELETE CASCADE |
| `blocked_id` | FK → `issues.id` ON DELETE CASCADE |
| PK | `(blocker_id, blocked_id)` |
| CHECK | `blocker_id <> blocked_id` (no self-loops) |

**Contract 3.4.1 (no self-loops).** Self-loops are rejected by both a
JS guard in `dependencyAdd` and the column CHECK constraint.

**Contract 3.4.2 (no cycles).** The block graph is acyclic. Two SQL
helpers enforce this:

- `CYCLE_CHECK_SQL` — given a new edge `(blocker, blocked)`, walks
  forward from `blocked` and returns a non-empty row if `blocker` is
  reachable. Used at insert time; rejection message: *"would close a
  cycle"*.
- `FIND_CYCLE_SQL` — recursive walk over the whole graph that returns
  a representative cycle path (first and last node equal) bounded by
  `array_length < ~200`. Used by `assertNoCycles` at import time and
  by the picker's diagnostic when no eligible issues exist.

**Contract 3.4.3 (bounded detector).** Acyclic chains longer than the
internal length bound are *not* misclassified as cycles; they simply
return null. The bound protects against pathological inputs, not
against representable but legitimate dep graphs.

### 3.5 `phase_events`

Append-only ledger of phase transitions and heartbeats.

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `issue_id` | FK → `issues.id` ON DELETE CASCADE |
| `version_id` | FK → `issue_versions.id` ON DELETE **SET NULL** |
| `phase_from` | text |
| `phase_to` | text (equal to `phase_from` for heartbeats) |
| `agent_id` | text, nullable |
| `reason` | text |
| `metadata` | jsonb |
| `created_at` | timestamp |

**Contract 3.5.1 (round-trip).** The `metadata` jsonb round-trips
byte-for-byte through `transitionPhase` and `appendPhaseEvent`.

**Contract 3.5.2 (atomic with phase).** A phase change writes the
`issues.phase` UPDATE and the `phase_events` row in the same
transaction; rollback discards both. `appendPhaseEvent` does **not**
change `issues.phase` and is the heartbeat marker (`phase_from =
phase_to`).

**Contract 3.5.3 (DESC by id).** `recentPhaseEvents(issueId, n)`
returns the most recent `n` events in DESC order.

### 3.6 `issue_branches`

One row per issue, created by the worker's handoff.

| Column | Notes |
|---|---|
| `issue_id` | PK, FK → `issues.id` ON DELETE CASCADE |
| `ref_name` | text NOT NULL (`refs/bogstandard/issue-<id>`) |
| `head_sha` | text NOT NULL (issue branch tip at handoff time) |
| `base_sha` | text NOT NULL (merge base) |
| `published_at` | timestamp NOT NULL DEFAULT NOW() |
| `merged_at` | timestamp nullable (set by finalize) |
| `merge_sha` | text nullable (set by finalize) |

### 3.7 `merge_tasks` and `merge_task_steps`

The merger has its own bespoke task queue.

`merge_tasks`:

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `idempotency_key` | text UNIQUE; format `"merge:<issueId>"` |
| `params` | jsonb (carries `issueId` and optional `repairModel`) |
| `state` | text in `{pending, running, completed, failed}` |
| `attempts` | int, incremented per claim |
| `last_error` | text nullable |
| `started_at` | timestamp nullable |
| `completed_at` | timestamp nullable |

`merge_task_steps`:

| Column | Notes |
|---|---|
| `id` | bigint PK |
| `task_id` | FK → `merge_tasks.id` ON DELETE CASCADE |
| `name` | text |
| `seq` | int monotone per `(task_id, name)` |
| `value` | jsonb (cached step result) |

**Contract 3.7.1 (claim semantics).** `runOnce` selects one row from
`merge_tasks` where `state IN ('pending', 'running')` with `FOR UPDATE
SKIP LOCKED`, transitions it to `running`, sets `started_at` if
unset, increments `attempts`.

**Contract 3.7.2 (step replay).** Each `ctx.step(name, fn)` inserts a
new `merge_task_steps` row with the next monotone `seq` for that
`(task_id, name)`. On re-runs, the row is read and the cached `value`
is replayed without invoking `fn`. Steps are never deleted; the
table is the source of truth for "what has already happened on this
task."

**Contract 3.7.3 (idempotent enqueue).** `ENQUEUE_MERGE_TASK_SQL`
inserts with `ON CONFLICT (idempotency_key) DO NOTHING ... RETURNING`,
unioned with a SELECT of the existing row so that the return shape
is the same in both branches: `{id, created}` with `created = false`
on duplicate.

### 3.8 `agent_config`

Single-row table holding the per-project default agent id.

- PK `id` with CHECK `id = 1` (only one row ever allowed).
- Columns: `agent_id`, `description`.

This is what `bs-import` populates from a chainlink `agent.json`.

### 3.9 `pgmigrations`

Bootstrap table for `node-pg-migrate`. Created on first invocation
of `applyMigrations` if missing. Migrations are applied in numeric
filename order; recorded one row per applied file. Idempotent across
runs.

---

## 4. Issue lifecycle and the phase machine

### 4.1 The phase set

The full set, matching TLA+ `Phases` plus the two phases the TLA+
model omits (`drafting`, `archived`):

| Phase | Held by | Terminal? | Notes |
|---|---|---|---|
| `drafting` | (none) | No | Newly created via Designer; pre-classification |
| `ready` | (none) | No | Eligible for the picker once `needs_tests IS NOT NULL` |
| `planning` | Worker | No | No-tests plan |
| `implementing` | Worker | No | No-tests impl |
| `red_planning` | Worker | No | TDD plan for failing tests |
| `red_impl` | Worker | No | TDD impl for failing tests |
| `green_planning` | Worker | No | TDD plan for production code |
| `green_impl` | Worker | No | TDD impl for production code |
| `merging_pending` | (queue) | No | Worker has published; daemon has not claimed |
| `merging` | Merger | No | Daemon has claimed; merge/test in progress |
| `merge_repair` | Merger | No | Conflict or post-merge test failure; repair agent in progress |
| `merge_failed` | (none) | **Yes** | Repair bail or unresolvable failure; durable ref preserved |
| `done` | (none) | **Yes** | Either landed via main or closed-no-change |
| `aborted` | (none) | **Yes** | Worker explicitly aborted from a working phase |
| `archived` | (none) | **Yes** | Designer-only; out of scope for /bs-task |

**Classification helpers** (`isWorkingPhase`, `isMidWorkPhase`,
`TerminalPhases` in TLA+):

- **Working phases** (worker holds ownership): `planning`,
  `implementing`, `red_planning`, `red_impl`, `green_planning`,
  `green_impl`.
- **Merge-flow phases**: `merging_pending`, `merging`, `merge_repair`,
  `merge_failed`.
- **Terminal phases** in the TLA+ sense: `done`, `aborted`,
  `merge_failed` (and operationally `archived`).
- **Initial**: a newly created issue is `drafting`.

### 4.2 Transition mechanics

**Contract 4.2.1 (optimistic from-check).** `transitionPhase` is an
atomic conditional UPDATE. The caller supplies a `from` phase; if the
DB's current phase doesn't match, the update affects zero rows and
the helper throws `"precondition failed"`. Callers may omit `from`
to bypass the check (used for force-resets).

**Contract 4.2.2 (ownership on transition).** Entry to any
*non-working* phase (`done`, `aborted`, `archived`, `ready`,
`drafting`) clears `current_agent_id` to null. Entry to a working
phase preserves the existing owner.

**Contract 4.2.3 (atomic with event).** The UPDATE of `issues.phase`
and the INSERT of the `phase_events` row are in the same transaction.
A failure in either rolls back both.

**Contract 4.2.4 (versionId resolution).** Both `transitionPhase` and
`appendPhaseEvent` auto-look-up `current_version_id` from `issues` if
the caller doesn't supply one. Explicit overrides (including
explicit null) are respected. Auto-lookup on a missing issue throws.

### 4.3 Worker transitions

The worker drives an issue from `ready` through one of two pipelines
to one of three endings (merge-bound, no-change-closed, aborted) or
a release (WIP-quit).

```
                              +-----------+
                              |   ready   |
                              +-----+-----+
                                    |
                  needs_tests=false | needs_tests=true
                                    |
                       +------------+------------+
                       v                         v
                +-----------+              +---------------+
                | planning  |              | red_planning  |
                +-----+-----+              +-------+-------+
                      |                            |
                      v                            v
                +-----------+              +---------------+
                |implementing|<--+         |   red_impl    |
                +-----+-----+   |          +-------+-------+
                      |         |                  |
            +---------+         |                  v
            |                   |          +---------------+
            |                   |          |green_planning |
            |                   |          +-------+-------+
            |                   |                  |
            |                   |                  v
            |                   |          +---------------+
            |                   |     +--->|  green_impl   |---bail--+
            |                   |     |    +-------+-------+         |
            |                   |     |            |                 |
            |                   |     +------------+   (bail)        |
            |                   |                  |                 |
            +---------+         |                  v                 |
                      |         |          (publish or no-change)    |
                      v         |                                    |
            +-----------+       |                                    |
            |publish or |       |                                    |
            |no-change  |       |   bail loops back to red_planning ─┘
            +-----------+
```

**Contract 4.3.1 (planning → impl).** From any planning phase, the
only legal next phase is the corresponding impl phase: `planning →
implementing`, `red_planning → red_impl`, `green_planning →
green_impl`.

**Contract 4.3.2 (red → green planning).** `red_impl → green_planning`
fires when the implementer reports that the red tests fail as
expected (the "red" deliverable). The red diff is captured in the
event metadata for the green planner to inline (see Contract 4.5.1).

**Contract 4.3.3 (bail loop).** `green_impl → red_planning` is the
bail path, taken when the implementer calls `bail_out`. Each issue
has a per-issue `bail_count`, incremented on each bail; further bails
are forbidden once `bail_count >= MAX_BAILS` (TLA+ `BailBound`).

**Contract 4.3.4 (publish handoff).** Only `implementing` and
`green_impl` may transition to `merging_pending`. `red_impl` cannot
publish; its only outgoing edge is to `green_planning`.

**Contract 4.3.5 (no-changes close).** Any impl phase (`implementing`,
`red_impl`, `green_impl`) may transition directly to `done` via the
no-changes path when the working tree is clean and no commits are
ahead of `main`. This skips the merge daemon entirely; the issue is
never added to `main_committed`, but it lands in `closed_no_change`
(see Contract 12.6).

**Contract 4.3.6 (abort).** Any working phase may transition to
`aborted`, clearing the owner.

**Contract 4.3.7 (WIP-quit).** "Not done, quitting" *does not change
the phase*; it clears `current_agent_id` and leaves the issue
claimable. The issue stays in whatever working phase it was in.

### 4.4 Merge-daemon transitions

These are driven only by `bs-merge-worker`.

| From | To | Action |
|---|---|---|
| `merging_pending` | `merging` | Daemon claims a task and starts the merge sequence |
| `merging` | `done` | `finalizeMerge` succeeded |
| `merging` | `merge_repair` | Merge conflict or post-merge test failure |
| `merge_repair` | `merging` | Repair agent committed; re-run tests/finalize |
| `merge_repair` | `merge_failed` | Repair bail or repeated failure |

The daemon may also choose **not** to advance the phase on a transient
error: if the pre-merge test on plain `main` fails, the task is
re-queued and the issue remains `merging_pending` (see §8.3).

### 4.5 Phase-state reconstruction

When `loadState` rebuilds in-flight state from the `phase_events`
ledger:

**Contract 4.5.1 (plan restoration).** The current `plan` is read
from the metadata of the most recent transition *into* the current
impl phase. Concretely: in `implementing` look at the latest
`* → implementing` event; in `red_impl` at the latest `* → red_impl`;
in `green_impl` at the latest `* → green_impl`. Plans from one phase
are never mixed into another.

**Contract 4.5.2 (red diff carry-forward).** When the current phase is
`green_planning` (or any later TDD phase that needs it), `redDiff`
is restored from a transition-into-`green_planning` event's metadata.

**Contract 4.5.3 (bail SHA scope).** `bailRedSha` is restored from a
transition-into-`red_planning` event's metadata, but **only** while
the current phase is `red_planning`. It does not leak into other
phases. This matters because bail resets the red commit, and we must
not re-apply a reset SHA in a later context.

---

## 5. Eligibility and blockers

The picker (`listEligible` / `ELIGIBLE_SQL`) is the single source of
truth for which issue a worker picks next.

### 5.1 The eligibility predicate

An issue is eligible iff **all** of the following hold:

1. `phase = 'ready'`.
2. `needs_tests IS NOT NULL` (classification done).
3. Either it has no blockers, or every blocker is in a *resolved*
   phase. Resolved phases are `done` and `archived` (the TLA+ model
   does not track `archived` and treats only `done` as resolved; the
   implementation widens this to `archived` to match Designer
   workflows).
4. It is not currently held: either `current_agent_id IS NULL`, or
   the same agent re-claims, or the existing lock is stale (see §6).

### 5.2 Blocker resolution

**Contract 5.2.1 (aborted blockers count).** An `aborted` blocker is
*not* resolved. The blocked issue stays ineligible until the aborted
blocker is either archived, redrafted back to `ready`, or otherwise
resolved.

**Contract 5.2.2 (merge-flow blockers count).** A blocker in any
merge-flow phase (`merging_pending`, `merging`, `merge_repair`,
`merge_failed`) is *not* resolved. This is the operational
counterpart of the TLA+ `MergeSoundness` invariant: a handed-off-
but-not-finalized blocker is not an acceptable foundation for
downstream work.

**Contract 5.2.3 (no-changes close counts).** An issue closed via the
no-changes path satisfies blocker resolution because it is `done`
and the empty diff is trivially on `main`. TLA+ tracks this
separately via `closed_no_change`; both branches satisfy `b \in
main_committed \/ b \in closed_no_change`.

### 5.3 Stale-claim handling

**Contract 5.3.1 (strict boundary).** `isPhaseStale(t, timeoutMin)`
returns true iff `(now - t) > timeoutMin`. Exactly at the boundary it
returns false: the claim is not yet stale. Null `t` returns false.

**Contract 5.3.2 (null timestamp).** A row with non-null
`current_agent_id` and **null** `phase_started_at` is treated by the
picker as a fresh claim and is excluded from eligibility. This is the
defence against a partial insert leaving a phantom owner.

### 5.4 Ordering

`ORDER BY priority DESC, id ASC`, where `priority DESC` resolves to
`critical, high, medium, low` via a CASE in the SQL. The CHECK
constraint on `priority` makes the CASE's ELSE arm unreachable in
practice (a comment in `eligibility.integration.test.ts` notes
this).

### 5.5 Adjacent queries

- `listPendingMerges` returns any issue currently in a merge-flow
  phase (`merging_pending`, `merging`, `merge_repair`, `merge_failed`).
  Used operationally to see what the daemon owes.
- `findBlockCycle` is the whole-graph cycle detector. It is called by
  the picker as a diagnostic when there are no eligible issues, and
  by `bs-import` before committing the chainlink data.

---

## 6. Ownership and locking

### 6.1 Ownership operations

| Operation | Behaviour |
|---|---|
| `claimIssue(id, agent, timeoutMin)` | Fresh row → succeeds. Same agent → succeeds (heartbeat). Different agent + fresh claim → fails. Different agent + stale claim → succeeds (steal). |
| `releaseIssue(id, agent)` | Clears `current_agent_id` only if `agent` owns it. No-op on missing or foreign-owned rows. |
| `stealIssue(id, agent)` | Unconditional claim; resets `phase_started_at`. |
| `touchOwnership(id, agent)` | Bumps `phase_started_at` when caller owns it; no-op otherwise. |
| `loadState(agent)` / `findOwnedIssue` | Returns the issue currently owned by `agent`. Excludes terminal phases (done/aborted/archived) even if `current_agent_id` matches. Tie-break: `phase_started_at DESC, id DESC` — most recent wins. |

**Contract 6.1.1 (concurrent claims).** Two agents racing for the same
fresh row will see exactly one winner (or, in degenerate timing,
none) — never two. This is enforced by the conditional UPDATE rather
than by an external lock.

**Contract 6.1.2 (steal by staleness, not by intent).** A worker does
not "decide" to steal another worker's issue; it simply attempts a
claim, and the same claim path succeeds against a stale lock and
fails against a fresh one. This unifies the protocol.

**Contract 6.1.3 (heartbeat semantics).** Same-agent re-claim and
explicit `touchOwnership` both bump `phase_started_at`. This is how
a long-running worker prevents being stolen from while it is doing
real work.

### 6.2 Relationship to the phase machine

Ownership is a property of the **issue row** (`current_agent_id`),
not of the phase. A working phase + null owner is a valid state
that means "WIP committed, no driver right now" (see §7.7 WIP-quit).
A terminal phase + non-null owner can transiently exist between
issue update and ownership clear inside `transitionPhase`, but
externally it should appear cleared because the two happen in one
transaction.

---

## 7. Worker workflow (`/bs-task`)

A worker run is a single iteration of: pick → plan → implement →
close (publish, no-change, abort, or quit). Each step has named
"boundaries" that, in single-shot mode, cause the worker process to
exit (§11).

### 7.1 Pick or accept an issue

- **Auto-pick** (no positional arg): runs `listEligible` (§5) and
  takes the first result.
- **Explicit id** (positional arg to `/bs-task`): skips the picker.

In both cases the issue is shown for review with options:
**continue**, **add a comment**, **switch to a different issue**,
**abort**.

**Pre-claim shutdown boundaries** (single-shot exits before any
ownership is acquired):

| Boundary | Cause |
|---|---|
| `no_eligible` | Picker found nothing |
| `invalid_issue` | Explicit id doesn't exist |
| `missing_needs_tests` | Explicit id is `drafting` with null `needs_tests` |
| `aborted_before_planning` | User chose abort at the review screen |
| `claim_failed` | Race lost to another agent |
| `dirty_tree` | Repo is dirty before claim |

### 7.2 Planning

The planner agent runs in a sandboxed tool surface:

- **Read tools**: `read`, `grep`, `find`, `ls`, `bash` (read-only by
  convention).
- **Planner-specific tools**: `questionnaire`, `save_plan`,
  `propose_redraft`.
- **Forbidden**: file edits, git mutation, direct DB access.

The planner's system prompt is a "software architect" persona; the
implementer's is a "software engineer" persona.

**Contract 7.2.1 (plan review UI).** When `save_plan` is called, a
scrollable plan viewer opens.

- **Enter** accepts the plan; the worker transitions
  `planning → implementing` (or red/green variant).
- **Escape** drops to a "Send instructions / Abort" prompt. User
  instructions re-enter the planner in the same session; the viewer
  re-opens. The loop terminates only on Enter (accept) or Abort.

**Contract 7.2.2 (propose_redraft).** If the planner concludes that
the issue is malformed and calls `propose_redraft`, the worker
records the proposed redraft diagnosis, transitions the issue to
`aborted`, and shuts down via the `redraft_proposed` boundary. The
Designer can then pick the issue up out of `aborted`.

**Contract 7.2.3 (questionnaire).** The planner may emit clarifying
questions via the `questionnaire` tool; answers are appended into
the session and the planner continues.

**Contract 7.2.4 (planning-phase shutdown).**
Planning-phase boundaries in single-shot mode: `aborted_resume_or_
plan_review` (user abort during plan review) and `redraft_proposed`.

**Contract 7.2.5 (redraft atomicity).** `redraftIssue` is one
transaction that: (a) requires non-empty `title` and non-empty
`carry_forward_summary`; (b) requires current phase ∈ `{drafting,
ready, aborted}`; (c) inserts version v(n+1) with a monotone
`version_no`; (d) flips `current_version_id`; (e) inserts a single
`carry_forward` comment attached to the new version; (f) writes a
`phase_events` row with `reason = "redraft"`, `phase_to = "ready"`,
`metadata.version_no = n+1`. The UNIQUE `(issue_id, version_no)`
constraint ensures concurrent redrafts produce exactly one winner;
the loser's transaction rolls back cleanly.

### 7.3 Implementation

The implementer runs with the full mutating tool surface (edits,
writes, bash) plus, in green-impl, the `bail_out` tool. The approved
plan is embedded verbatim in the implementer's prompt; the red diff
is inlined into the green planner's prompt.

**Contract 7.3.1 (end-reason classification).** After the agent
stream ends, `endReason()` classifies the run from `(phase, stopReason,
savedState)`:

| Phase | Stop reason | Saved state | Result |
|---|---|---|---|
| any impl | `stop` | (none special) | `completed` |
| any planning | `aborted` | plan saved | `tool-terminate` (save_plan path) |
| `green_impl` | `aborted` or `stop` | `bailReason` set | `tool-terminate` (bail_out, declarative override) |
| any planning | `aborted` or `stop` | `redraftDiagnosis` set | `tool-terminate` (propose_redraft) |
| any impl | `aborted` | (none) | `interrupted` |
| any planning | `aborted` | (no plan yet) | `interrupted` |
| any | `error` | (no saved state) | `interrupted` |
| any | `length` or empty | — | `completed` |

The `bailReason`-in-`green_impl` row is a *declarative override*:
even if the stop reason looks like a hard error, the presence of a
`bailReason` says "this is a tool-driven exit," and we treat it
accordingly.

### 7.4 TDD red/green/bail loop

Each TDD prompt has strict scope language so that the resulting diff
stays in its lane:

| Phase | Scope | Key prompt directive |
|---|---|---|
| `red_planning` | tests only | "Do NOT plan any production-code changes" |
| `red_impl` | tests only | "Write tests only"; "no skip/xfail markers"; red must fail |
| `green_planning` | production only | "Do not list test files here"; red diff inlined |
| `green_impl` | production only | tests must pass; "do not modify test files from the red phase"; `bail_out` available |

**Contract 7.4.1 (red commit).** After red_impl completes, the worker
commits with message `"Testing phase: red"` and transitions to
`green_planning`.

**Contract 7.4.2 (bail).** `bail_out` from green_impl:

- Posts a diagnosis comment to the issue.
- Resets the red commit (`git reset` to the prior `bailRedSha`).
- Transitions `green_impl → red_planning`.
- Increments `bail_count`.
- If `bail_count == MAX_BAILS`, further bails are refused — the run
  ends in an `aborted` state instead.

**Contract 7.4.3 (clean tree precondition).** The TDD path requires a
clean working tree before `red_planning` starts. A dirty tree at
this point triggers a `dirty_tree` boundary.

### 7.5 Close routing

Before publishing or closing, the worker classifies the working tree
state via `routeCloseAction(isTreeClean, commitCount)`:

| `isTreeClean` | `commitCount` | Result |
|---|---|---|
| true | 0 | `no_changes` (skip daemon, phase → `done`) |
| true | > 0 | `publish_existing` (push the existing branch) |
| false | any | `commit_then_publish` (commit then push) |

**Contract 7.5.1 (dirtiness dominates).** A dirty tree always requires
a commit, regardless of `commitCount`. The route is a flat 1-of-3
decision; there is no "dirty + 0 commits" case that closes the issue
without a commit.

### 7.6 Publish (handoff to daemon)

The handoff is a tight transaction-with-pre-step that survives both
worker crashes and concurrent retries.

**Sequence:**

1. `git update-ref refs/bogstandard/issue-<id> <head_sha>` —
   publishes the durable ref **before any DB write**, so that DB
   recovery can confirm what is already on disk.
2. `BEGIN`.
3. `UPSERT issue_branches (issue_id, ref_name, head_sha, base_sha)`.
4. Conditional `UPDATE issues SET phase = 'merging_pending'` from
   the expected `fromPhase` (`implementing` or `green_impl`).
5. `INSERT phase_events` with `metadata = {ref_name, head_sha,
   base_sha}`.
6. `INSERT merge_tasks (idempotency_key = "merge:<issueId>", params,
   state = 'pending')` — `ON CONFLICT DO NOTHING` with a unioned
   SELECT so the return is `{id, created}` either way.
7. `COMMIT`.
8. Best-effort: detach `HEAD` from any `bogstandard/worker-*/issue-*`
   branch and delete the worker branch. Failures here are logged
   warnings and **do not fail the handoff**.

**Contract 7.6.1 (publish before DB).** The git ref is published
before the DB transaction so that, if the DB transaction aborts, the
ref is still discoverable on retry. If git publishing fails, the DB
transaction is never attempted.

**Contract 7.6.2 (idempotent handoff).** On retry of the same
handoff:

- The `UPSERT` of `issue_branches` succeeds (same row, same SHAs).
- The conditional UPDATE fails (issue is already `merging_pending`),
  returning `rowCount = 0`.
- A recovery query (`SELECT_HANDOFF_RETRY_SQL`) verifies that an
  already-committed handoff with matching SHAs exists.
- The merge task is re-enqueued (no-op on conflict).
- No second `phase_events` row is written, no ref re-publish is
  attempted.

**Contract 7.6.3 (best-effort cleanup).** Branch cleanup is observed
to fail in a number of legitimate ways (detached HEAD already, branch
already deleted, branch name doesn't match the bogstandard pattern,
etc.); none of these fail the handoff.

**Contract 7.6.4 (single-shot boundary).** Successful publish triggers
the `queued_for_merge` boundary and the worker exits in single-shot
mode.

### 7.7 WIP-quit and abort

| Action | Phase change | Owner cleared? | Boundary |
|---|---|---|---|
| WIP-quit ("Not done, quitting") | none | yes | `wip_quit` |
| Abort during plan review / resume | → `aborted` | yes | `aborted_resume_or_plan_review` |
| Abort during continue prompt | → `aborted` | yes | `continue_cancelled` |
| Abort pre-claim | (n/a) | n/a | `aborted_before_planning` |

**Contract 7.7.1 (WIP-quit preserves phase).** The issue stays in
whatever working phase it was in. Picking it up later means resuming
that phase, not starting over.

---

## 8. Merge-daemon workflow (`bs-merge-worker`)

### 8.1 Startup checks

Before any task is claimed, the daemon validates that it can do its
job:

**Contract 8.1.1 (merge config).** The `merge` block must exist in
`.bogstandard/config.json`. It must include `test_command` (non-empty
string array), `test_timeout_seconds`, and `staging_worktree`. A
`repair_model` is optional and may also be specified per task in the
task params; resolution checks task param first, then daemon config,
and only then errors with a usage hint.

**Contract 8.1.2 (staging worktree exists).** `git worktree list
--porcelain` must list the configured staging path. If not, the
daemon throws with the absolute staging path and the remediation
command `git worktree add --detach <path> main`.

**Contract 8.1.3 (config error UX).** Errors raised during startup
include the path to `.bogstandard/config.json` so an operator can
edit the right file without guessing.

### 8.2 Task claim and step replay

The daemon's outer loop:

1. `runOnce(pool, handler, workerId)` — claims one task as in
   Contract 3.7.1.
2. The handler is invoked with a `ctx` that exposes `ctx.step(name,
   fn)` (and a lower-level `beginStep`/`completeStep`).
3. On a successful handler return: `state = completed`, `completed_at
   = now()`.
4. On a permanent error: `state = failed`, `last_error` stored,
   `completed_at` set.
5. On a transient error (as classified by `isTransientError`):
   `state = pending`, leaving the row for re-claim. By default all
   errors are permanent; the daemon overrides this with a small set
   of transient classes.
6. If the queue is empty: `runOnce` returns false; the daemon sleeps
   and tries again (or, in `--once` mode, exits).

**Contract 8.2.1 (step replay).** Each named step writes a row on
first call and reads its cached `value` on subsequent calls. The
table is monotone — rows are never deleted or updated. After a
daemon crash mid-handler, the next claim of the same task replays
each step as `done=true` and resumes appending at the next unwritten
step. Concretely: if a daemon dies after writing seqs 0 and 1 for
step `merge`, the next runner replays both as cached and resumes
at the post-merge test step.

**Contract 8.2.2 (re-claim of `running`).** A task left in `running`
because the previous daemon died is not "lost." The claim query
matches `state IN ('pending', 'running')`, so it is re-claimed,
attempts incremented, and the step replay resumes the handler.

### 8.3 Merge sequence

For one task with `params.issueId = i`:

1. **Preflight** the staging worktree.
   - `git fetch origin main` (failure → transient abort).
   - Hard-reset the staging worktree to `refs/heads/main`.
   - Detach HEAD.
   - Remove untracked files.
2. **Pre-merge test** the unmerged main.
   - Run `test_command` with `test_timeout_seconds`.
   - On failure: raise `MainIsRedError` (transient). The task is
     re-queued; the issue stays in `merging_pending`. The staging
     worktree is left intact; the next claim re-preflights.
3. Transition `issues.phase` from `merging_pending` → `merging`.
4. **Merge** the issue ref into the staging worktree using
   `git merge --no-ff refs/bogstandard/issue-<i>`.
5. **Post-merge test** the result.
6. Branch on outcome:
   - **Clean merge + tests pass** → step 7 (finalize).
   - **Conflict** → enter repair-agent path.
   - **Clean merge + tests fail** → enter repair-agent path.
7. **Finalize** (`finalizeMerge`):
   - Assert staging is clean (no staged/unstaged/untracked changes).
   - Assert HEAD is a no-ff merge commit (two parents).
   - Assert the issue ref is an ancestor of HEAD.
   - If a `repairStartSha` was recorded, assert HEAD differs from
     it (the repair must actually change something).
   - `UPDATE issue_branches SET merged_at = now(), merge_sha = ?`.
   - `UPDATE issues SET phase = 'done'`.
   - Advance `refs/heads/main` to the merge SHA.
   - Sync any other worktrees with `refs/heads/main` attached so
     their working trees follow `main`.

**Contract 8.3.1 (repair agent).** The repair agent runs with CWD set
to the staging worktree and a fixed tool surface: `read`, `grep`,
`find`, `ls`, `bash`, `edit`, `write`, `bail_out`. Model resolution
follows §8.1.

- If the agent calls `bail_out`, the merge fails immediately and the
  issue transitions to `merge_failed`.
- If the agent finishes without committing, the merge fails (the
  repair didn't produce anything to test).
- If the agent commits, post-merge tests are re-run.
  - Pass → step 7 (finalize). The recorded `repairStartSha` is the
    pre-repair HEAD; finalize asserts HEAD has moved.
  - Fail → issue transitions to `merge_failed`.

**Contract 8.3.2 (repair on test failure without conflict).** A
clean-merge post-test-failure goes through the repair agent even
though there are no merge conflicts to resolve. The agent's job in
that case is to fix the failing tests on the merged result.

**Contract 8.3.3 (finalize idempotency).** `finalizeMerge` is
idempotent:

- If the issue is already `done` and the recorded `merge_sha` matches
  the candidate, finalize is a no-op (clean up the issue ref).
- If the issue is `done` but `merge_sha` is null or mismatched, the
  call fails and the issue ref is preserved as evidence of the
  inconsistency.

**Contract 8.3.4 (durable ref lifecycle).**
- On a successful merge, the durable ref `refs/bogstandard/issue-<i>`
  is deleted after `main` has been advanced.
- On `merge_failed`, the durable ref is **left alive** so a human can
  inspect or replay it.

**Contract 8.3.5 (worktree sync).** After advancing `main`, the daemon
finds all other worktrees registered to `refs/heads/main` (i.e.,
worktrees attached to the branch, not just any worktree) and syncs
them. An operator-edited worktree caught mid-sync is detected as
dirty and the sync is aborted without advancing.

### 8.4 Failure modes recap

| Symptom | What happens |
|---|---|
| Pre-merge test fails on main | Transient. Task re-queued. Issue stays `merging_pending`. |
| Git fetch fails | Transient. Same handling. |
| Merge conflict | Repair agent runs. |
| Post-merge tests fail (clean merge) | Repair agent runs. |
| Repair agent bails | Issue → `merge_failed`. Durable ref preserved. |
| Repair commits but tests still fail | Issue → `merge_failed`. Durable ref preserved. |
| Finalize sees dirty staging | Aborts without advancing `main`. |
| Finalize sees fast-forward merge | Rejects (not a valid `--no-ff`). |
| Daemon dies mid-handler | Next claim replays steps and resumes. |

---

## 9. Designer (`/bs-design`)

The Designer is a conversational agent. It is invoked by an operator
to brainstorm and shape issues. The tool surface and prompts make
clear that it is not a worker.

### 9.1 Tool surface

`list_issues`, `show_issue`, `draft_issue`, `update_issue`,
`redraft_issue`, `add_comment`, `block`, `unblock`, `archive`.

The Designer cannot:

- Close issues (`done`). Closing belongs to `/bs-task` exclusively.
- Modify source files, run git, or run SQL.
- Mark needs_tests for issues other than via the draft buffer
  (`needs_tests:` line).

### 9.2 Draft buffer format

Drafts are edited via a textual buffer:

```
title: <title, may contain colons>
priority: <low|medium|high|critical>
needs_tests: <true|false>
---
<multiline description>
```

**Contract 9.2.1 (parse rules).**
- Title may include colons.
- Priority must be one of the four enum values exactly.
- `needs_tests` must be present and must be exactly `true` or
  `false`.
- The `---` separator is required.
- Empty title is rejected.

### 9.3 Kickoff prompt

When `/bs-design` starts, it renders the open/draft/aborted tracker:

- Empty state when there are no open, draft, or aborted issues.
- Each ready issue listed as `#id priority — title`.
- "Pending drafts" section for `drafting` issues.
- Aborted issues with an optional reason inline.
- The prompt encourages batching multiple drafts into a single turn.

### 9.4 Redraft semantics

The Designer's `redraft_issue` tool calls into the same `redraftIssue`
DB operation used elsewhere (Contract 7.2.5). It is the canonical
path out of `aborted`. Title and `carry_forward_summary` are
required; phase is reset to `ready`; the new version begins at
`version_no = (current max) + 1`.

---

## 10. Configuration, setup, import, migrations

### 10.1 Configuration precedence

| Field | Sources, in order |
|---|---|
| `databaseUrl` | `--bs-database-url` flag → `BOGSTANDARD_DATABASE_URL` env → `.bogstandard/config.json:database_url` → error |
| `agentId` | `--bs-agent-id` flag → `BOGSTANDARD_AGENT_ID` env → `.bogstandard/config.json:agent_id` → `"main"` |
| `staleLockTimeoutMinutes` | file only → default `60` |
| `merge` block | file only; partial merge over defaults |

Default merge block: `test_command = ["npm", "test"]`,
`test_timeout_seconds = 600`, `staging_worktree =
.bogstandard/merge-staging`, `repair_model = undefined`.

**Contract 10.1.1 (no env database URL is an error).** An empty
string or missing value for `databaseUrl` after all sources is an
error; it is not silently defaulted.

**Contract 10.1.2 (agent id default).** With no flag, no env, and no
file entry, the agent id defaults to `"main"`.

### 10.2 Setup (`bs-setup`)

**Contract 10.2.1 (URL parsing).** `splitDatabaseUrl` parses the
provided `postgres://...` URL into `{adminUrl, dbName}`. The
adminUrl substitutes `postgres` for the dbName path segment while
preserving credentials, host, and port. Missing dbName in the path
throws.

**Contract 10.2.2 (safe identifier).** The dbName is validated
against a regex that allows letters, digits, and underscores;
rejects hyphens, leading digits, quotes, semicolons, and any other
non-identifier character. This is the only protection against SQL
injection into `CREATE DATABASE`.

**Contract 10.2.3 (idempotent setup).** The full `runSetup`:

- Connects to the admin DB; creates the target DB if missing.
- Applies all migrations up to the current head (0006) via
  `node-pg-migrate`.
- Writes `.bogstandard/config.json` with `force` controlling
  overwrite.
- Creates the staging worktree at the configured path under the git
  repo root.

Repeated runs with `force=true` produce exactly one `pgmigrations`
row per migration and a single `merge_tasks` table.

**Contract 10.2.4 (writeConfig defaults).** `writeConfig` emits
snake_case keys, defaults `agent_id = "main"` and
`stale_lock_timeout_minutes = 60`, and seeds the merge block.
Refuses to overwrite an existing config without `force = true`.

**Contract 10.2.5 (git repo precondition).** Setup throws an
actionable error if the target git repo has no `main` branch — the
staging worktree cannot be created against a missing base.

### 10.3 Migrations

Applied in numeric order, recorded one row per applied file in
`pgmigrations`.

| Migration | Effect |
|---|---|
| 0001 init | All initial tables. `CREATE TABLE IF NOT EXISTS` so 0001 is safe on pre-pgmigrations DBs. |
| 0002 draft status | Adds the `draft` value to the legacy `status` column's CHECK constraint. |
| 0003 phase state + versioning | Introduces `issue_versions`, `phase_events`, the `phase` enum on issues, backfills `status → phase` (open→ready, draft→drafting, closed→done, archived→archived), backfills `comments.version_id` to v1, drops `status`/`title`/`description` from `issues`, drops `idx_issues_status`, drops the `locks` table, sets `issues.phase` NOT NULL. v1 rows carry `needs_tests = NULL` so legacy issues require classification. |
| 0004 drop parent_id | Backfills each `parent_id` edge into `dependencies` (child blocks parent). Pre-existing duplicate edges absorbed by ON CONFLICT. Detects cycles after backfill; **raises and rolls back** if any cycle exists. Drops `parent_id` and its index only after a clean cycle check. |
| 0005 merge phases | Extends `issues.phase` CHECK with merge-flow values. Creates `issue_branches`. |
| 0006 merge queue | Creates `merge_tasks` and `merge_task_steps`. |

**Contract 10.3.1 (idempotent applyMigrations).** A second invocation
with no new files added applies nothing. A custom `migrations/`
directory is supported (used by tests).

**Contract 10.3.2 (cycle-safe 0004).** Migration 0004 is the only
migration that can refuse to apply on an otherwise valid pre-state:
it raises if the post-backfill graph would be cyclic, leaving the
schema untouched.

**Contract 10.3.3 (`bs-migrate` is upgrade-only).** `bs-migrate`
runs migrations only; it does not create the database. Use
`bs-setup` first for a new project.

### 10.4 Chainlink import (`bs-import`)

`bs-import` migrates a chainlink sqlite database into the configured
Postgres database. The full flow is wrapped in a single transaction:

1. `assertTargetEmpty` — refuses non-empty `issues` unless `force`.
2. `migrateIssues` — preserves ids, bumps `issues_id_seq`, creates
   v1 of `issue_versions` per issue, converts `parent_id` edges to
   `dependencies` (child blocks parent). Unknown chainlink statuses
   default to `ready`.
3. `migrateComments` — preserves ids, bumps `comments_id_seq`,
   defaults `kind = "note"` if null, attaches every comment to v1
   of its issue. Orphan comments (issue not in import map) are
   warned and skipped.
4. `migrateDeps` — inserts dependencies with `ON CONFLICT DO
   NOTHING` (dedupes); does not throw on duplicates.
5. `migrateAgentJson` — reads `agent.json`; skips with a warning if
   missing/malformed/missing `agent_id`; UPSERTs the single
   `agent_config` row.
6. `assertNoCycles` — runs `findBlockCycle`; throws with the cycle
   path if any cycle was created.

**Contract 10.4.1 (transactional all-or-nothing).** Any failure rolls
back the entire import.

**Contract 10.4.2 (status fallback).** Unknown chainlink statuses
become `ready`. The known map is: `open → ready`, `draft →
drafting`, `closed → done`, `archived → archived`.

---

## 11. Single-shot vs long-running modes

BogStandard supports two operational modes that share the same code
path; the difference is a single flag.

### 11.1 `bs-run` (single-shot)

`bs-run` is a thin wrapper that orchestrates one worker iteration
followed by one merger drain.

**Contract 11.1.1 (invocation).** `bs-run` invokes pi with arguments
arranged as:

```
pi [<args after --, before /bs-task>] /bs-task [<issueId>] --bs-single-shot
```

- A positional issue id (immediately after `bs-run`) goes after
  `/bs-task`.
- Any tokens after `--` are forwarded to pi *before* `/bs-task` so
  they are recognised as pi flags (e.g., model selection).
- `/bs-task` must precede `--bs-single-shot`; otherwise the pi parser
  would consume `/bs-task` as a flag value.
- Positional tokens that are not preceded by `--` and are not the
  optional issue id are rejected with `exit 2`.

**Contract 11.1.2 (exit code propagation).**

- pi exits non-zero → `bs-run` exits with pi's code; merger is **not**
  invoked.
- pi exits 0 → merger is invoked with `--once`.
  - Merger non-zero → `bs-run` exits with the merger's code.
  - Merger 0 → `bs-run` exits 0.

**Contract 11.1.3 (single-shot shutdown).**
`shouldShutdownInSingleShot(flag, boundary)`:

- `flag = false/undefined`: always returns false.
- `flag = true`: returns true for every boundary in the set below
  *except* `continue_working`, which always returns false.

| Boundary | Trigger |
|---|---|
| `queued_for_merge` | Successful publish (§7.6) |
| `no_change_closed` | No-changes close (§4.3.5) |
| `no_eligible` | Picker found nothing |
| `invalid_issue` | Explicit id missing |
| `missing_needs_tests` | `needs_tests` not classified |
| `claim_failed` | Lost the claim race |
| `dirty_tree` | Pre-claim or pre-TDD dirty tree |
| `aborted_before_planning` | User abort at issue review |
| `aborted_resume_or_plan_review` | User abort during resume/plan review |
| `redraft_proposed` | Planner called `propose_redraft` |
| `wip_quit` | "Not done, quitting" |
| `continue_cancelled` | User abort at the continue prompt |
| `continue_working` | The *only* non-terminal boundary; worker loops |

### 11.2 `dispatch.sh` (long-running, multi-worker)

`./dispatch.sh N [-- <pi args>]` creates N git worktrees off `main`,
writes a per-worktree `.bogstandard/config.json` with a unique
`agent_id` (`worker-1`, …, `worker-N`), and starts a pi session in
each. All workers share the same Postgres database. The merger
(`bs-merge-worker`) runs separately as a daemon and consumes the
queue continuously.

**Contract 11.2.1 (one lock row per agent).** Per-worker `agent_id`s
allow each session to hold its own claims independently; the
`current_agent_id` column resolves the per-issue lock by identity.

**Contract 11.2.2 (cleanup).** `./dispatch.sh --cleanup` tears down
the worktrees and their branches.

---

## 12. Safety invariants (lifted from TLA+)

Each invariant below is paraphrased in English with the TLA+
identifier in parentheses for traceability. All are checked by TLC
under both the long-running and single-shot configs in
`spec/tla/BogStandard.cfg` and `BogStandard_SingleShot.cfg`.

**12.1 Owner ↔ worker map agreement (`MutualExclusion`).** If issue
`i` reports owner `w`, then worker `w` reports its current issue as
`i`, and vice versa.

**12.2 One issue per worker, none of them terminal
(`OneIssuePerWorker`).** A worker driving an issue means that issue is
not in a terminal phase. `ready` is allowed because `Claim` runs as
a separate step from `StartPlanning` — matching the implementation
where `claimIssue` and `transitionPhase` are two distinct DB
operations.

**12.3 TDD shape (`PhaseShapeOK`).** An issue may only enter the four
TDD sub-phases (`red_planning`, `red_impl`, `green_planning`,
`green_impl`) if it `needs_tests`. An issue may only enter the two
non-TDD phases (`planning`, `implementing`) if it does **not**
`needs_tests`. Mode is fixed at issue creation in the model.

**12.4 Bail bound (`BailBound`).** For every issue, `bail_count ≤
MAX_BAILS`. The implementation refuses further bails at the boundary,
and the spec's `BailGreen` action is guarded by the same condition.

**12.5 Merge soundness (`MergeSoundness`).** When a worker is in a
planning phase for issue `i`, every blocker of `i` is either in
`main_committed` (landed via the merger) or in `closed_no_change`
(closed via the no-changes path). An issue that has been handed off
to the merger but not yet finalized — i.e., one in `merging_pending`,
`merging`, `merge_repair`, or `merge_failed` — is **not** an
acceptable blocker. This is what makes the picker's exclusion of
merge-flow phases load-bearing.

**12.6 Done ⇒ resolved (`DoneImpliesResolved`).** Every issue with
`phase = "done"` is either in `main_committed` or in
`closed_no_change`. This is stronger than `MergeSoundness` alone:
it catches a hypothetical future bug where a worker or daemon writes
`done` without going through either of the two legitimate
resolution paths.

**12.7 Single-shot monotonicity (`SingleShotMonotone`).** An inactive
(single-shot exited) worker holds no claim. Trivially true in
long-running mode (workers stay active forever); meaningful in
single-shot mode where it catches a release path that forgets to
clear `worker_issue`.

### 12.8 Structural invariants

`TypeOK` is the type-correctness invariant: every variable is in its
declared domain. It is checked in both configs but does not state a
behavioural property; it exists so that a violated invariant elsewhere
is easier to debug.

---

## 13. Out of scope / known gaps

This section is deliberately explicit so that future readers don't
mistake omissions for guarantees.

### 13.1 Out of scope in the TLA+ model

- The `Steal` action — stale-heartbeat takeover of another worker's
  claim — exists in the implementation (`db.ts:1024` per the TLA+
  comments) and is exercised by `ownership.integration.test.ts`, but
  the TLA+ model does not include it. The spec text in §6.1 reflects
  the implementation, not the model.
- `MainIsRedError` is not a distinct daemon iteration in the model;
  it is covered implicitly by `MergeStart` being a nondeterministic
  optional action.
- The `merge_tasks` queue is abstracted away in the spec: the
  daemon's per-issue actions fire nondeterministically rather than
  via `FOR UPDATE SKIP LOCKED` claims and `merge_task_steps`
  checkpoints.
- `dispatch.sh` worktree mechanics are not modelled; workers in the
  spec already have independent state.
- Designer (`/bs-design`) is not modelled at all.
- `drafting` and `archived` phases are not in the spec's `Phases`
  set — issues are born `ready` in the model and `archived` is
  treated as a Designer concern outside the worker machine.

### 13.2 Concrete git is abstracted

- An issue's git state is abstracted to three booleans/flags:
  unpublished (`ref_published[i] = FALSE`), published for the
  daemon, or merged to `main` (`i \in main_committed`).
- No SHA arithmetic, no diff representation, no concrete conflict
  payloads.

### 13.3 Bounded cycle detector

`FIND_CYCLE_SQL`'s walk is bounded by an internal length limit
(~200 nodes). Long acyclic chains beyond this bound are not reported
as cyclic; they simply return null. This bound exists to protect
against pathological inputs and is documented in
`tests/dependencies.integration.test.ts`.

### 13.4 Pre-`61b2df3` databases

The `pgmigrations` table is bootstrapped on first run, and 0001 is
written with `CREATE TABLE IF NOT EXISTS` so it is a no-op on legacy
DBs. There is no separate forward migration for databases that
predate the bootstrap; the bootstrap *is* the path.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **Worker** | An agent that runs `/bs-task` and produces an issue branch. |
| **Merger** | The `bs-merge-worker` daemon. Single consumer of the merge queue. |
| **Designer** | The conversational issue-CRUD agent (`/bs-design`). |
| **Issue** | A row in `issues` plus its current `issue_versions` row plus its history. |
| **Version** | A snapshot of an issue's title/description/needs_tests/created_by. |
| **Blocker** | An issue listed in `dependencies.blocker_id` for some other issue. |
| **Phase** | A value of `issues.phase`; total set in §4.1. |
| **Working phase** | One of `{planning, implementing, red_planning, red_impl, green_planning, green_impl}`. Worker is the driver. |
| **Merge-flow phase** | One of `{merging_pending, merging, merge_repair, merge_failed}`. Merger is the driver. |
| **Terminal phase** | One of `{done, aborted, merge_failed}` (and operationally `archived`). |
| **Boundary** | A named point at which a worker may shut down in single-shot mode. |
| **Durable issue ref** | `refs/bogstandard/issue-<id>`, the worker's handoff artefact. |
| **Staging worktree** | The git worktree the merger uses for pre/post-merge tests and conflict resolution. |
| **Step** | A unit of merger work that is durably checkpointed in `merge_task_steps`. |
| **Bail** | A `green_impl → red_planning` transition driven by the `bail_out` tool. |
| **No-changes close** | `implementing|red_impl|green_impl → done` directly, bypassing the merger. |
| **WIP-quit** | "Not done, quitting": clears owner without changing phase. |
| **Stale lock** | A claim whose `phase_started_at` is older than `stale_lock_timeout_minutes` (strict `>`). |
| **TLA+ `main_committed`** | The model's representation of "issue `i`'s code has landed on `refs/heads/main`." |
| **TLA+ `closed_no_change`** | The model's representation of "issue `i` was resolved via the no-changes path." |
