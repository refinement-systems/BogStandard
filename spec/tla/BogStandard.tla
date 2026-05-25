------------------------- MODULE BogStandard -------------------------
\* BogStandard /bs-task phase machine across N concurrent workers,
\* with an abstract model of git/merge state.
\*
\* v1 (this module) reproduces the *current* implementation: workers
\* commit to per-worktree branches and mark issues `done` without ever
\* merging back to main. The `MergeSoundness` invariant exhibits the
\* resulting bug — TLC will find a short counterexample.
\*
\* What this models concretely:
\*   - the phase set from db.ts:66-77 (minus 'drafting' and 'archived':
\*     issues are born 'ready', and archive is a Designer concern)
\*   - the atomic conditional-UPDATE transition pattern in db.ts:800
\*   - the claim-on-ownership protocol (db.ts:970), simplified: no
\*     stale-heartbeat takeover, no Steal, no release-without-completion
\*   - the TDD red/green/bail loop, bounded by MAX_BAILS
\*   - the eligibility predicate from issue-picker.ts:46 (a blocker
\*     issue counts as resolved iff phase = "done")
\*
\* What is abstracted:
\*   - pi runtime: each agent step is one atomic, nondeterministic action
\*   - Postgres: transitionPhase / claimIssue are atomic
\*   - git mechanics: no conflict modelling; an issue's work is either
\*     not yet started, on a branch, or (in v2) merged to main
\*   - Designer: skipped entirely
\*
\* Deliberately omitted in v1; planned for v2:
\*   - Steal action (db.ts:1007)
\*   - Release without completion (the "Not done, quitting" path)
\*   - work_state / branch_base / a Merge action that advances
\*     main_committed (the fix for the bug this spec exhibits)
\*
\* Topology is hardcoded for v1: two workers (w1, w2), two issues
\* (i1 no-tests, i2 TDD), i1 blocks i2. TLC's cfg parser only accepts
\* bare model-value literals, so the worker/issue sets and the
\* needs_tests + blocker relations are defined here rather than in the
\* cfg. v2 will likely move to an MC-style model wrapper for variants.

EXTENDS Naturals, FiniteSets

CONSTANTS
  MAX_BAILS,    \* natural — bail cap (matches handleBail's guard)
  NULL,         \* sentinel for "no owner" / "no issue"
  w1, w2,       \* worker model values
  i1, i2        \* issue model values

Workers == {w1, w2}
Issues  == {i1, i2}

NeedsTests(i) == i = i2
Blockers(i)   == IF i = i2 THEN {i1} ELSE {}

VARIABLES
  issue_phase,    \* [Issues -> Phases]
  issue_owner,    \* [Issues -> Workers \cup {NULL}]
  worker_issue,   \* [Workers -> Issues \cup {NULL}]
  main_committed, \* SUBSET Issues
  bail_count      \* [Issues -> 0..MAX_BAILS]

vars == <<issue_phase, issue_owner, worker_issue, main_committed, bail_count>>

\* ── Phase classification ────────────────────────────────────────────────

Phases == {"ready",
           "planning",       "implementing",
           "red_planning",   "red_impl",
           "green_planning", "green_impl",
           "done",           "aborted"}

PlanningPhases == {"planning", "red_planning", "green_planning"}
ImplPhases     == {"implementing", "red_impl", "green_impl"}
WorkingPhases  == PlanningPhases \cup ImplPhases
TerminalPhases == {"done", "aborted"}

\* ── State invariants ───────────────────────────────────────────────────

TypeOK ==
  /\ issue_phase    \in [Issues -> Phases]
  /\ issue_owner    \in [Issues -> Workers \cup {NULL}]
  /\ worker_issue   \in [Workers -> Issues \cup {NULL}]
  /\ main_committed \subseteq Issues
  /\ bail_count     \in [Issues -> 0..MAX_BAILS]

Init ==
  /\ issue_phase    = [i \in Issues  |-> "ready"]
  /\ issue_owner    = [i \in Issues  |-> NULL]
  /\ worker_issue   = [w \in Workers |-> NULL]
  /\ main_committed = {}
  /\ bail_count     = [i \in Issues  |-> 0]

\* ── Eligibility (issue-picker.ts:46) ───────────────────────────────────
\*
\* A `ready` issue is eligible when it is unclaimed and every blocker has
\* reached `done`. The picker also accepts `archived` blockers as
\* resolved; we don't model `archived`. `aborted` blockers count as
\* unresolved, matching today's picker. needs_tests-is-set is a constant
\* truth in our model (every issue in Issues has a fixed NeedsTests
\* classification at init).
Eligible(i) ==
  /\ issue_phase[i] = "ready"
  /\ issue_owner[i] = NULL
  /\ \A b \in Blockers(i) : issue_phase[b] = "done"

\* ── Actions ────────────────────────────────────────────────────────────

\* claimIssue (db.ts:970): conditional update sets current_agent_id.
\* In our model the worker must be idle (one issue per worker).
Claim(w, i) ==
  /\ worker_issue[w] = NULL
  /\ Eligible(i)
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = w]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = i]
  /\ UNCHANGED <<issue_phase, main_committed, bail_count>>

\* /bs-task: ready → red_planning if needs_tests else planning
\* (index.ts:386). Atomic in transitionPhase.
StartPlanning(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "ready"
  /\ issue_phase' = [issue_phase EXCEPT ![i] =
                       IF NeedsTests(i) THEN "red_planning" ELSE "planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, bail_count>>

\* Plan accepted: planning_phase → corresponding impl_phase.
CompletePlanning(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in PlanningPhases
  /\ \/ /\ issue_phase[i] = "planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "implementing"]
     \/ /\ issue_phase[i] = "red_planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "red_impl"]
     \/ /\ issue_phase[i] = "green_planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "green_impl"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, bail_count>>

\* No-tests path: implementing → done. THE BUG: never merges to main.
\* (closeAndCommit at index.ts:1112 commits to the worker branch only.)
CompleteImpl(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] = "implementing"
  /\ issue_phase'  = [issue_phase  EXCEPT ![i] = "done"]
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = NULL]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = NULL]
  /\ UNCHANGED <<main_committed, bail_count>>

\* TDD red impl complete: red_impl → green_planning
\* (finalizeRedImplementation at index.ts:971).
CompleteRedImpl(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] = "red_impl"
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "green_planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, bail_count>>

\* TDD green impl complete: green_impl → done. Same merge bug.
CompleteGreenImpl(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] = "green_impl"
  /\ issue_phase'  = [issue_phase  EXCEPT ![i] = "done"]
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = NULL]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = NULL]
  /\ UNCHANGED <<main_committed, bail_count>>

\* Green bail: green_impl → red_planning (handleBail at index.ts:1036).
\* bail_count is per-issue (a bailed-then-resumed issue can bail again).
BailGreen(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "green_impl"
  /\ bail_count[i]   < MAX_BAILS
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "red_planning"]
  /\ bail_count'  = [bail_count  EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed>>

\* Abort: any working phase → aborted (covers user-abandon during resume,
\* propose_redraft accepted, planner Ctrl-C with no recovery, …).
Abort(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in WorkingPhases
  /\ issue_phase'  = [issue_phase  EXCEPT ![i] = "aborted"]
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = NULL]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = NULL]
  /\ UNCHANGED <<main_committed, bail_count>>

Next ==
  \E w \in Workers, i \in Issues :
    \/ Claim(w, i)
    \/ StartPlanning(w, i)
    \/ CompletePlanning(w, i)
    \/ CompleteImpl(w, i)
    \/ CompleteRedImpl(w, i)
    \/ CompleteGreenImpl(w, i)
    \/ BailGreen(w, i)
    \/ Abort(w, i)

Spec == Init /\ [][Next]_vars

\* ── Safety invariants ──────────────────────────────────────────────────

\* An issue's owner and the worker_issue map agree both ways.
MutualExclusion ==
  /\ \A i \in Issues : issue_owner[i] # NULL =>
       worker_issue[issue_owner[i]] = i
  /\ \A w \in Workers : worker_issue[w] # NULL =>
       issue_owner[worker_issue[w]] = w

\* A worker driving an issue means that issue is not in a terminal phase.
\* `ready` is included (Claim runs before StartPlanning transitions phase —
\* matching the real code where claimIssue and transitionPhase are two
\* separate DB calls in index.ts:380-411).
OneIssuePerWorker ==
  \A w \in Workers : worker_issue[w] # NULL =>
    issue_phase[worker_issue[w]] \notin TerminalPhases

\* TDD sub-phases only when needs_tests; non-TDD only when not.
PhaseShapeOK ==
  \A i \in Issues :
    /\ issue_phase[i] \in {"red_planning", "red_impl",
                           "green_planning", "green_impl"}
         => NeedsTests(i)
    /\ issue_phase[i] \in {"planning", "implementing"}
         => ~NeedsTests(i)

BailBound ==
  \A i \in Issues : bail_count[i] <= MAX_BAILS

\* THE BUG-EXHIBIT INVARIANT.
\*
\* When a worker enters a planning phase for issue i, every blocker of i
\* must already be on main — not merely marked `done` in the DB. Today's
\* code violates this: CompleteImpl / CompleteGreenImpl transition to
\* `done` without ever advancing main_committed, so a downstream worker
\* can claim and plan an issue whose blocker's code is still on an
\* unmerged worker branch.
\*
\* v1 has no merge action at all, so main_committed = {} forever, and
\* this invariant fails the first time any issue with blockers reaches
\* a planning phase. The expected counterexample is six steps:
\*   Claim(w1,i1), StartPlanning(w1,i1), CompletePlanning(w1,i1),
\*   CompleteImpl(w1,i1), Claim(w2,i2), StartPlanning(w2,i2).
\* v2 will add a `merging` phase + Merge action and re-check this.
MergeSoundness ==
  \A w \in Workers, i \in Issues :
    (worker_issue[w] = i /\ issue_phase[i] \in PlanningPhases)
      => (\A b \in Blockers(i) : b \in main_committed)

============================================================================
