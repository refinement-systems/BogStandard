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

-- Migration 0004: collapse subissue tree into the block DAG.
--
-- The chainlink-era split between `issues.parent_id` (subissue tree) and
-- `dependencies(blocker_id, blocked_id)` (block DAG) was redundant: the
-- picker gated eligibility on both relations with identical semantics. This
-- migration converts every parent_id edge into an equivalent block edge
-- (subissue blocks parent — matching the picker's prior behaviour), verifies
-- the resulting graph is acyclic, then drops the column.
--
-- Backfill is idempotent (ON CONFLICT DO NOTHING) so re-running on a partially
-- migrated database is safe. The cycle check is a belt-and-braces guard: the
-- prior parent_id tree should be acyclic, but this is the last point at which
-- we can verify before the column disappears.

-- 1. Backfill parent_id edges into dependencies.
INSERT INTO dependencies (blocker_id, blocked_id)
SELECT id, parent_id FROM issues WHERE parent_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2. Verify the block graph is acyclic. RAISE EXCEPTION rolls back the txn.
DO $$
DECLARE cycle_path bigint[];
BEGIN
  WITH RECURSIVE walk(start_id, current_id, path, found) AS (
    SELECT id, id, ARRAY[id]::bigint[], false FROM issues
    UNION ALL
    SELECT w.start_id,
           d.blocked_id,
           w.path || d.blocked_id,
           d.blocked_id = w.start_id
      FROM walk w
      JOIN dependencies d ON d.blocker_id = w.current_id
     WHERE NOT w.found
       AND array_length(w.path, 1) < 200
       AND NOT (d.blocked_id = ANY(w.path) AND d.blocked_id <> w.start_id)
  )
  -- Qualify `found` as `walk.found`: inside a DO block, plain `found` is
  -- ambiguous between the CTE column and PL/pgSQL's `FOUND` diagnostic
  -- variable, and Postgres 18 rejects the query as ambiguous.
  SELECT path INTO cycle_path FROM walk WHERE walk.found LIMIT 1;
  IF cycle_path IS NOT NULL THEN
    RAISE EXCEPTION 'Block-graph cycle detected after backfill: %', cycle_path;
  END IF;
END $$;

-- 3. Drop the column and its index.
DROP INDEX IF EXISTS idx_issues_parent;
ALTER TABLE issues DROP COLUMN IF EXISTS parent_id;
