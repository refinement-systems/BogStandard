------------------------- MODULE BogStandard -------------------------
\* BogStandard /bs-task phase machine across N concurrent workers,
\* with an abstract model of git/merge state.
\*
\* v2 models the merge-flow fix: workers publish issue refs, a merge daemon
\* lands those refs on main, and `done` means the issue's code is on main.
\*
\* What this models concretely:
\*   - the phase set from db.ts:66-85 (minus 'drafting' and 'archived':
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
\*   - git mechanics: no concrete SHA/conflict modelling; an issue ref is
\*     either unpublished, published for the daemon, or merged to main
\*   - Designer: skipped entirely
\*
\* Deliberately omitted:
\*   - Steal action (db.ts:1007)
\*   - Release without completion (the "Not done, quitting" path)
\*   - the no-commits-to-merge shortcut, which can transition directly to
\*     done in implementation; every modeled implementation publishes a ref
\*   - concrete merge conflicts/tests/repair-agent transcript details
\*
\* Topology is hardcoded: two workers (w1, w2), two issues
\* (i1 no-tests, i2 TDD), i1 blocks i2. TLC's cfg parser only accepts
\* bare model-value literals, so the worker/issue sets and the
\* needs_tests + blocker relations are defined here rather than in the
\* cfg. A future larger model can move this to an MC-style wrapper.

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
  ref_published,  \* [Issues -> BOOLEAN]
  bail_count      \* [Issues -> 0..MAX_BAILS]

vars == <<issue_phase, issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* ── Phase classification ────────────────────────────────────────────────

Phases == {"ready",
           "planning",       "implementing",
           "red_planning",   "red_impl",
           "green_planning", "green_impl",
           "merging_pending", "merging",
           "merge_repair",   "merge_failed",
           "done",           "aborted"}

PlanningPhases == {"planning", "red_planning", "green_planning"}
ImplPhases     == {"implementing", "red_impl", "green_impl"}
WorkingPhases  == PlanningPhases \cup ImplPhases
TerminalPhases == {"done", "aborted", "merge_failed"}

\* ── State invariants ───────────────────────────────────────────────────

TypeOK ==
  /\ issue_phase    \in [Issues -> Phases]
  /\ issue_owner    \in [Issues -> Workers \cup {NULL}]
  /\ worker_issue   \in [Workers -> Issues \cup {NULL}]
  /\ main_committed \subseteq Issues
  /\ ref_published  \in [Issues -> BOOLEAN]
  /\ bail_count     \in [Issues -> 0..MAX_BAILS]

Init ==
  /\ issue_phase    = [i \in Issues  |-> "ready"]
  /\ issue_owner    = [i \in Issues  |-> NULL]
  /\ worker_issue   = [w \in Workers |-> NULL]
  /\ main_committed = {}
  /\ ref_published  = [i \in Issues  |-> FALSE]
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
  /\ UNCHANGED <<issue_phase, main_committed, ref_published, bail_count>>

\* /bs-task: ready → red_planning if needs_tests else planning
\* (index.ts:386). Atomic in transitionPhase.
StartPlanning(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "ready"
  /\ issue_phase' = [issue_phase EXCEPT ![i] =
                       IF NeedsTests(i) THEN "red_planning" ELSE "planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

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
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* Worker handoff: implementation completion publishes a durable
\* refs/bogstandard/issue-<id> handle, clears worker ownership, and waits
\* for the merge daemon. Red implementation still goes to green planning,
\* so only no-tests implementing and TDD green_impl can publish.
PublishRef(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in {"implementing", "green_impl"}
  /\ ref_published[i] = FALSE
  /\ issue_phase'  = [issue_phase  EXCEPT ![i] = "merging_pending"]
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = NULL]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = NULL]
  /\ ref_published' = [ref_published EXCEPT ![i] = TRUE]
  /\ UNCHANGED <<main_committed, bail_count>>

\* TDD red impl complete: red_impl → green_planning
\* (finalizeRedImplementation at index.ts:971).
CompleteRedImpl(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] = "red_impl"
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "green_planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* Green bail: green_impl → red_planning (handleBail at index.ts:1036).
\* bail_count is per-issue (a bailed-then-resumed issue can bail again).
BailGreen(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "green_impl"
  /\ bail_count[i]   < MAX_BAILS
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "red_planning"]
  /\ bail_count'  = [bail_count  EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published>>

\* Abort: any working phase → aborted (covers user-abandon during resume,
\* propose_redraft accepted, planner Ctrl-C with no recovery, …).
Abort(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in WorkingPhases
  /\ issue_phase'  = [issue_phase  EXCEPT ![i] = "aborted"]
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = NULL]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = NULL]
  /\ UNCHANGED <<main_committed, ref_published, bail_count>>

\* Merge daemon claim: the issue has been handed off and is now being
\* tested/merged in the daemon's staging worktree.
MergeStart(i) ==
  /\ issue_phase[i] = "merging_pending"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merging"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* Happy path: the daemon lands the published ref on main, deletes the
\* durable issue ref, and only then marks the issue done.
MergeSucceed(i) ==
  /\ issue_phase[i] = "merging"
  /\ ref_published[i]
  /\ issue_phase'    = [issue_phase    EXCEPT ![i] = "done"]
  /\ main_committed' = main_committed \cup {i}
  /\ ref_published'  = [ref_published  EXCEPT ![i] = FALSE]
  /\ UNCHANGED <<issue_owner, worker_issue, bail_count>>

\* Conflicts or post-merge test failures enter the repair-agent phase.
MergeConflict(i) ==
  /\ issue_phase[i] = "merging"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merge_repair"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* A successful repair returns to merging, where tests/merge finalization
\* are modeled by a subsequent MergeSucceed.
RepairFix(i) ==
  /\ issue_phase[i] = "merge_repair"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merging"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

\* Repair bail leaves the durable ref alive for human inspection and ends
\* the automated workflow for this issue in the v2 model.
RepairBail(i) ==
  /\ issue_phase[i] = "merge_repair"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merge_failed"]
  /\ UNCHANGED <<issue_owner, worker_issue, main_committed, ref_published, bail_count>>

Next ==
  \/ \E w \in Workers, i \in Issues :
       \/ Claim(w, i)
       \/ StartPlanning(w, i)
       \/ CompletePlanning(w, i)
       \/ PublishRef(w, i)
       \/ CompleteRedImpl(w, i)
       \/ BailGreen(w, i)
       \/ Abort(w, i)
  \/ \E i \in Issues :
       \/ MergeStart(i)
       \/ MergeSucceed(i)
       \/ MergeConflict(i)
       \/ RepairFix(i)
       \/ RepairBail(i)

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

\* Merge-soundness invariant.
\*
\* When a worker enters a planning phase for issue i, every blocker of i
\* must already be on main, not merely handed off to the merge daemon.
\* Since Eligible only accepts blockers in phase `done`, and v2 only enters
\* `done` through MergeSucceed, this should hold.
MergeSoundness ==
  \A w \in Workers, i \in Issues :
    (worker_issue[w] = i /\ issue_phase[i] \in PlanningPhases)
      => (\A b \in Blockers(i) : b \in main_committed)

\* Stronger than MergeSoundness: all done issues must have landed on main.
DoneImpliesMainCommitted ==
  \A i \in Issues : issue_phase[i] = "done" => i \in main_committed

============================================================================
