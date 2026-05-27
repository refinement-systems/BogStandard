------------------------- MODULE BogStandard -------------------------
\* BogStandard /bs-task phase machine across N concurrent workers, with
\* an abstract model of git/merge state and an optional single-shot
\* worker-lifetime model.
\*
\* v3 (this file) layers two things on top of v2:
\*   - SINGLE_SHOT mode, modeling the bs-run wrapper's contract that a
\*     pi process exits after one terminal boundary (single-shot.ts,
\*     12 maybeShutdown call sites in index.ts between 362 and 1257).
\*   - The two "release without going through merge" paths the v2 spec
\*     deliberately omitted: NoChangesClose (work_phase -> done, never
\*     enters the merge daemon) and WipQuit ("Not done, quitting"
\*     leaves the issue mid-phase with current_agent_id cleared).
\*
\* What this models concretely:
\*   - the phase set from db.ts:70 (minus 'drafting' and 'archived':
\*     issues are born 'ready', and archive is a Designer concern)
\*   - the atomic conditional-UPDATE transition pattern in db.ts:817
\*   - the claim-on-ownership protocol (db.ts:987), simplified: no
\*     stale-heartbeat takeover (no Steal)
\*   - the TDD red/green/bail loop, bounded by MAX_BAILS, with red
\*     finalisation from index.ts:1013 and green bail from
\*     index.ts:1078
\*   - the eligibility predicate from issue-picker.ts:46 (a blocker
\*     issue counts as resolved iff phase = "done")
\*   - the worker -> merge-daemon handoff and the merge daemon's
\*     happy / conflict / repair / repair-bail outcomes
\*   - the worker shutdown boundaries from single-shot.ts
\*     (queued_for_merge, no_change_closed, wip_quit, the aborted_*
\*     family, and the pre-claim early-exit boundaries)
\*
\* What is abstracted:
\*   - pi runtime: each agent step is one atomic, nondeterministic
\*     action
\*   - Postgres: transitionPhase / claimIssue are atomic
\*   - git mechanics: no concrete SHA/conflict modelling; an issue ref
\*     is either unpublished, published for the daemon, or merged to
\*     main
\*   - the merge_tasks queue: the daemon's per-issue steps fire
\*     nondeterministically rather than via FOR UPDATE SKIP LOCKED
\*     claims and step-checkpoints
\*   - Designer: skipped entirely
\*
\* Deliberately still omitted:
\*   - Steal action (db.ts:1024)
\*   - MainIsRedError (a daemon iteration that pre-fails on main and
\*     leaves the issue stuck in merging_pending); implicitly covered
\*     by MergeStart being nondeterministic
\*   - dispatch.sh worktree mechanics (workers in our model already
\*     have independent state)
\*
\* Topology is hardcoded: two workers (w1, w2), two issues (i1
\* no-tests, i2 TDD), i1 blocks i2. TLC's cfg parser only accepts bare
\* model-value literals, so the worker/issue sets and the needs_tests
\* + blocker relations are defined here rather than in the cfg. A
\* future larger model can move this to an MC-style wrapper.
\*
\* Two configs are shipped:
\*   - BogStandard.cfg            -- SINGLE_SHOT = FALSE (long-running
\*                                   workers, the dispatch.sh model)
\*   - BogStandard_SingleShot.cfg -- SINGLE_SHOT = TRUE  (bs-run model;
\*                                   each worker fires at most one
\*                                   boundary)

EXTENDS Naturals, FiniteSets

CONSTANTS
  MAX_BAILS,    \* natural - bail cap (matches handleBail's guard)
  SINGLE_SHOT,  \* BOOLEAN - TRUE models bs-run / --bs-single-shot
  NULL,         \* sentinel for "no owner" / "no issue"
  w1, w2,       \* worker model values
  i1, i2        \* issue model values

Workers == {w1, w2}
Issues  == {i1, i2}

NeedsTests(i) == i = i2
Blockers(i)   == IF i = i2 THEN {i1} ELSE {}

VARIABLES
  issue_phase,      \* [Issues -> Phases]
  issue_owner,      \* [Issues -> Workers \cup {NULL}]
  worker_issue,     \* [Workers -> Issues \cup {NULL}]
  worker_active,    \* [Workers -> BOOLEAN]  -- pi process still alive
  main_committed,   \* SUBSET Issues          -- code landed on main
  closed_no_change, \* SUBSET Issues          -- done via no-changes path
  ref_published,    \* [Issues -> BOOLEAN]
  bail_count        \* [Issues -> 0..MAX_BAILS]

vars == <<issue_phase, issue_owner, worker_issue, worker_active,
          main_committed, closed_no_change, ref_published, bail_count>>

\* -- Phase classification ----------------------------------------------

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

\* -- State invariants --------------------------------------------------

TypeOK ==
  /\ issue_phase      \in [Issues -> Phases]
  /\ issue_owner      \in [Issues -> Workers \cup {NULL}]
  /\ worker_issue     \in [Workers -> Issues \cup {NULL}]
  /\ worker_active    \in [Workers -> BOOLEAN]
  /\ main_committed   \subseteq Issues
  /\ closed_no_change \subseteq Issues
  /\ ref_published    \in [Issues -> BOOLEAN]
  /\ bail_count       \in [Issues -> 0..MAX_BAILS]

Init ==
  /\ issue_phase      = [i \in Issues  |-> "ready"]
  /\ issue_owner      = [i \in Issues  |-> NULL]
  /\ worker_issue     = [w \in Workers |-> NULL]
  /\ worker_active    = [w \in Workers |-> TRUE]
  /\ main_committed   = {}
  /\ closed_no_change = {}
  /\ ref_published    = [i \in Issues  |-> FALSE]
  /\ bail_count       = [i \in Issues  |-> 0]

\* -- Eligibility (issue-picker.ts:46) ----------------------------------
\*
\* A `ready` issue is eligible when it is unclaimed and every blocker has
\* reached `done`. The picker also accepts `archived` blockers as
\* resolved; we don't model `archived`. `aborted` blockers count as
\* unresolved, matching today's picker. needs_tests-is-set is a constant
\* truth in our model (every issue in Issues has a fixed NeedsTests
\* classification at init). The invariant DoneImpliesResolved (below)
\* lifts the phase-only check into the stronger "blocker is actually
\* resolved" guarantee that MergeSoundness depends on.
Eligible(i) ==
  /\ issue_phase[i] = "ready"
  /\ issue_owner[i] = NULL
  /\ \A b \in Blockers(i) : issue_phase[b] = "done"

\* Single-shot worker bookkeeping. In SINGLE_SHOT mode, a worker that
\* releases its issue (via PublishRef / Abort / NoChangesClose /
\* WipQuit) also exits; in long-running mode worker_active stays TRUE.
ReleaseWorker(w) ==
  IF SINGLE_SHOT
  THEN [worker_active EXCEPT ![w] = FALSE]
  ELSE worker_active

\* -- Actions -----------------------------------------------------------

\* claimIssue (db.ts:987): conditional update sets current_agent_id.
\* In our model the worker must be idle (one issue per worker) and its
\* pi process must still be alive.
Claim(w, i) ==
  /\ worker_active[w]
  /\ worker_issue[w] = NULL
  /\ Eligible(i)
  /\ issue_owner'  = [issue_owner  EXCEPT ![i] = w]
  /\ worker_issue' = [worker_issue EXCEPT ![w] = i]
  /\ UNCHANGED <<issue_phase, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* /bs-task: ready -> red_planning if needs_tests else planning
\* (index.ts route at the start of the agent loop). Atomic in
\* transitionPhase (db.ts:817).
StartPlanning(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "ready"
  /\ issue_phase' = [issue_phase EXCEPT ![i] =
                       IF NeedsTests(i) THEN "red_planning" ELSE "planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Plan accepted: planning_phase -> corresponding impl_phase.
CompletePlanning(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in PlanningPhases
  /\ \/ /\ issue_phase[i] = "planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "implementing"]
     \/ /\ issue_phase[i] = "red_planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "red_impl"]
     \/ /\ issue_phase[i] = "green_planning"
        /\ issue_phase' = [issue_phase EXCEPT ![i] = "green_impl"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Worker handoff: implementation completion publishes a durable
\* refs/bogstandard/issue-<id> handle, clears worker ownership, and
\* waits for the merge daemon. Red implementation still goes to green
\* planning, so only no-tests implementing and TDD green_impl can
\* publish. Boundary: queued_for_merge (index.ts:1257).
PublishRef(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in {"implementing", "green_impl"}
  /\ ref_published[i] = FALSE
  /\ issue_phase'    = [issue_phase    EXCEPT ![i] = "merging_pending"]
  /\ issue_owner'    = [issue_owner    EXCEPT ![i] = NULL]
  /\ worker_issue'   = [worker_issue   EXCEPT ![w] = NULL]
  /\ worker_active'  = ReleaseWorker(w)
  /\ ref_published'  = [ref_published  EXCEPT ![i] = TRUE]
  /\ UNCHANGED <<main_committed, closed_no_change, bail_count>>

\* No-changes close: closeAndCommit at index.ts:1217 routes a clean
\* working-tree-with-no-new-commits to a direct phase -> done
\* transition, skipping the merge daemon entirely. The issue's "code"
\* is the empty diff; it never touches main_committed.
\* Boundary: no_change_closed.
NoChangesClose(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in ImplPhases
  /\ ref_published[i] = FALSE
  /\ issue_phase'      = [issue_phase    EXCEPT ![i] = "done"]
  /\ issue_owner'      = [issue_owner    EXCEPT ![i] = NULL]
  /\ worker_issue'     = [worker_issue   EXCEPT ![w] = NULL]
  /\ worker_active'    = ReleaseWorker(w)
  /\ closed_no_change' = closed_no_change \cup {i}
  /\ UNCHANGED <<main_committed, ref_published, bail_count>>

\* TDD red impl complete: red_impl -> green_planning
\* (finalizeRedImplementation at index.ts:1013).
CompleteRedImpl(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] = "red_impl"
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "green_planning"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Green bail: green_impl -> red_planning (handleBail at
\* index.ts:1078). bail_count is per-issue (a bailed-then-resumed
\* issue can bail again).
BailGreen(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i]  = "green_impl"
  /\ bail_count[i]   < MAX_BAILS
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "red_planning"]
  /\ bail_count'  = [bail_count  EXCEPT ![i] = @ + 1]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published>>

\* Abort: any working phase -> aborted. Covers user-abandon during
\* resume, propose_redraft accepted, planner Ctrl-C with no recovery,
\* dirty_tree precondition failures after claim, etc. Boundaries:
\* aborted_resume_or_plan_review (index.ts:670), redraft_proposed
\* (index.ts:784), continue_cancelled (index.ts:912).
Abort(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in WorkingPhases
  /\ issue_phase'   = [issue_phase   EXCEPT ![i] = "aborted"]
  /\ issue_owner'   = [issue_owner   EXCEPT ![i] = NULL]
  /\ worker_issue'  = [worker_issue  EXCEPT ![w] = NULL]
  /\ worker_active' = ReleaseWorker(w)
  /\ UNCHANGED <<main_committed, closed_no_change, ref_published, bail_count>>

\* WIP quit: "Not done, quitting" at index.ts:965. WIP is committed
\* locally on the worker's branch, the issue stays in the same
\* working phase, but current_agent_id is cleared so the issue is
\* claimable again. Boundary: wip_quit.
WipQuit(w, i) ==
  /\ worker_issue[w] = i
  /\ issue_phase[i] \in WorkingPhases
  /\ issue_owner'   = [issue_owner   EXCEPT ![i] = NULL]
  /\ worker_issue'  = [worker_issue  EXCEPT ![w] = NULL]
  /\ worker_active' = ReleaseWorker(w)
  /\ UNCHANGED <<issue_phase, main_committed, closed_no_change,
                 ref_published, bail_count>>

\* Pre-claim early exit. In SINGLE_SHOT mode an idle worker can exit
\* without ever claiming an issue: no_eligible (index.ts:362),
\* invalid_issue (386), missing_needs_tests (395),
\* aborted_before_planning (406), claim_failed (419), or dirty_tree
\* (433) when no claim was held. Outside single-shot mode the worker
\* would loop back into the eligibility check rather than exit, so
\* this action is disabled.
WorkerGiveUp(w) ==
  /\ SINGLE_SHOT
  /\ worker_active[w]
  /\ worker_issue[w] = NULL
  /\ worker_active' = [worker_active EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<issue_phase, issue_owner, worker_issue, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Merge daemon claim: the issue has been handed off and is now being
\* tested/merged in the daemon's staging worktree.
MergeStart(i) ==
  /\ issue_phase[i] = "merging_pending"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merging"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Happy path: the daemon lands the published ref on main, deletes the
\* durable issue ref, and only then marks the issue done.
MergeSucceed(i) ==
  /\ issue_phase[i] = "merging"
  /\ ref_published[i]
  /\ issue_phase'    = [issue_phase    EXCEPT ![i] = "done"]
  /\ main_committed' = main_committed \cup {i}
  /\ ref_published'  = [ref_published  EXCEPT ![i] = FALSE]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active,
                 closed_no_change, bail_count>>

\* Conflicts or post-merge test failures enter the repair-agent phase.
MergeConflict(i) ==
  /\ issue_phase[i] = "merging"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merge_repair"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* A successful repair returns to merging, where tests/merge
\* finalization are modeled by a subsequent MergeSucceed.
RepairFix(i) ==
  /\ issue_phase[i] = "merge_repair"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merging"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

\* Repair bail leaves the durable ref alive for human inspection and
\* ends the automated workflow for this issue.
RepairBail(i) ==
  /\ issue_phase[i] = "merge_repair"
  /\ ref_published[i]
  /\ issue_phase' = [issue_phase EXCEPT ![i] = "merge_failed"]
  /\ UNCHANGED <<issue_owner, worker_issue, worker_active, main_committed,
                 closed_no_change, ref_published, bail_count>>

Next ==
  \/ \E w \in Workers, i \in Issues :
       \/ Claim(w, i)
       \/ StartPlanning(w, i)
       \/ CompletePlanning(w, i)
       \/ PublishRef(w, i)
       \/ NoChangesClose(w, i)
       \/ CompleteRedImpl(w, i)
       \/ BailGreen(w, i)
       \/ Abort(w, i)
       \/ WipQuit(w, i)
  \/ \E w \in Workers : WorkerGiveUp(w)
  \/ \E i \in Issues :
       \/ MergeStart(i)
       \/ MergeSucceed(i)
       \/ MergeConflict(i)
       \/ RepairFix(i)
       \/ RepairBail(i)

Spec == Init /\ [][Next]_vars

\* -- Safety invariants -------------------------------------------------

\* An issue's owner and the worker_issue map agree both ways.
MutualExclusion ==
  /\ \A i \in Issues : issue_owner[i] # NULL =>
       worker_issue[issue_owner[i]] = i
  /\ \A w \in Workers : worker_issue[w] # NULL =>
       issue_owner[worker_issue[w]] = w

\* A worker driving an issue means that issue is not in a terminal
\* phase. `ready` is included (Claim runs before StartPlanning
\* transitions phase - matching the real code where claimIssue
\* (db.ts:987) and transitionPhase (db.ts:817) are two separate DB
\* calls).
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
\* When a worker enters a planning phase for issue i, every blocker of
\* i must either be on main (merged via MergeSucceed) or have been
\* closed via the no-changes path (an empty diff is trivially on
\* main). Crucially, an issue handed off to the merge daemon but not
\* yet finalized is *not* an acceptable blocker.
MergeSoundness ==
  \A w \in Workers, i \in Issues :
    (worker_issue[w] = i /\ issue_phase[i] \in PlanningPhases)
      => (\A b \in Blockers(i) :
            b \in main_committed \/ b \in closed_no_change)

\* Stronger than MergeSoundness on its own: every done issue has been
\* resolved exactly once - either it merged onto main, or it closed
\* with no changes. Catches a future "done without going through
\* either path" bug.
DoneImpliesResolved ==
  \A i \in Issues :
    issue_phase[i] = "done"
      => (i \in main_committed \/ i \in closed_no_change)

\* Single-shot monotonicity: an inactive worker never holds a claim.
\* In SINGLE_SHOT = FALSE this is trivially true (worker_active stays
\* TRUE forever); in SINGLE_SHOT = TRUE this catches releases that
\* forget to clear worker_issue.
SingleShotMonotone ==
  \A w \in Workers : ~worker_active[w] => worker_issue[w] = NULL

============================================================================
