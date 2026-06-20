-- Permission to use, copy, modify, and/or distribute this software for
-- any purpose with or without fee is hereby granted.
--
-- THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
-- WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
-- OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
-- FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
-- DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
-- AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
-- OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

-- Migration 0007: explicit issue workflow classification.
--
-- `needs_tests` remains as the legacy Designer-facing compatibility field.
-- The worker now consumes `workflow_id`, with a deterministic backfill:
--   needs_tests = false -> direct
--   needs_tests = true  -> tdd
--   needs_tests = NULL  -> NULL (still unclassified / ineligible)

ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS workflow_id TEXT;

UPDATE issue_versions
   SET workflow_id = CASE
       WHEN needs_tests IS TRUE  THEN 'tdd'
       WHEN needs_tests IS FALSE THEN 'direct'
       ELSE NULL
   END
 WHERE workflow_id IS NULL;

ALTER TABLE issue_versions DROP CONSTRAINT IF EXISTS issue_versions_workflow_id_check;
ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_workflow_id_check
    CHECK (workflow_id IS NULL OR workflow_id IN ('direct', 'tdd'));
