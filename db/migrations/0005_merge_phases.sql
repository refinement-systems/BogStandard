-- Permission to use, copy, modify, and/or distribute this software for
-- any purpose with or without fee is hereby granted.
--
-- THE SOFTWARE IS PROVIDED “AS IS” AND THE AUTHOR DISCLAIMS ALL
-- WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
-- OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
-- FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
-- DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
-- AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
-- OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

-- Migration 0005: merge-flow phases + issue_branches handoff table.
--
-- Adds the four phase states that sit between *_impl and done in the
-- merge-flow design (plan_merge_flow.md §4). The existing picker
-- already treats anything other than 'done' / 'archived' as an
-- unresolved blocker, so these states block downstream work without
-- any SQL change to the eligibility query.
--
-- issue_branches is the durable record of "the worker has published a
-- ref and the merge daemon will eventually land it on main". One row
-- per issue; no row exists for the no-commits-clean-tree case (the
-- worker transitions straight to done).

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_phase_check;
ALTER TABLE issues ADD  CONSTRAINT issues_phase_check CHECK (phase IN (
    'drafting', 'ready',
    'planning', 'implementing',
    'red_planning', 'red_impl',
    'green_planning', 'green_impl',
    'merging_pending', 'merging', 'merge_repair', 'merge_failed',
    'done', 'aborted', 'archived'
));

CREATE TABLE IF NOT EXISTS issue_branches (
    issue_id     BIGINT      PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    ref_name     TEXT        NOT NULL,
    head_sha     TEXT        NOT NULL,
    base_sha     TEXT        NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at    TIMESTAMPTZ,
    merge_sha    TEXT
);
