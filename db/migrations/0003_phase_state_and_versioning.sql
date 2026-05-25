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

-- Migration 0003: issue-centric state machine + description versioning.
--
-- Replaces the chainlink-era split-table model with a single-row state
-- machine. Phase, ownership, and version pointer all live on `issues`. A
-- new `issue_versions` table holds the versioned title/description/needs_tests
-- snapshots, `comments.version_id` scopes each comment to one version, and
-- `phase_events` is the append-only audit log that replaces both
-- `pi.appendEntry` and the previous `<!-- bs-task:v=1 -->` comment markers.
--
-- Backfill is non-destructive: each existing issue gets a v1 row copied from
-- its title/description, existing comments are scoped to that v1, and the
-- `status` column is mapped to `phase` via:
--   open → ready, draft → drafting, closed → done, archived → archived.
-- `needs_tests` is left NULL on backfilled v1 rows; the picker treats NULL
-- as ineligible so the operator must classify legacy issues via /bs-design
-- before /bs-task will work them.

-- ── 1. issue_versions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issue_versions (
    id          BIGSERIAL PRIMARY KEY,
    issue_id    BIGINT      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    version_no  INT         NOT NULL,
    title       TEXT        NOT NULL,
    description TEXT,
    needs_tests BOOLEAN,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT,
    UNIQUE (issue_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_versions_issue ON issue_versions(issue_id);

INSERT INTO issue_versions (issue_id, version_no, title, description, created_at)
SELECT id, 1, title, description, created_at FROM issues
WHERE NOT EXISTS (SELECT 1 FROM issue_versions v WHERE v.issue_id = issues.id);

-- ── 2. issues: phase + ownership + version pointer ──────────────────────────

ALTER TABLE issues ADD COLUMN IF NOT EXISTS phase              TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS current_version_id BIGINT REFERENCES issue_versions(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS current_agent_id   TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS phase_started_at   TIMESTAMPTZ;

UPDATE issues
   SET current_version_id = v.id
  FROM issue_versions v
 WHERE v.issue_id = issues.id AND v.version_no = 1 AND issues.current_version_id IS NULL;

UPDATE issues SET phase = CASE
    WHEN status = 'draft'    THEN 'drafting'
    WHEN status = 'open'     THEN 'ready'
    WHEN status = 'closed'   THEN 'done'
    WHEN status = 'archived' THEN 'archived'
    ELSE 'ready'
  END
 WHERE phase IS NULL;

ALTER TABLE issues ALTER COLUMN phase SET NOT NULL;
-- current_version_id is *not* marked NOT NULL: issueCreate inserts the row
-- first, then the v1 row, then updates the pointer. Backfilled rows already
-- have the pointer set, so reads never see NULL in practice — issueShowJson's
-- JOIN naturally filters out any row that's mid-insert.

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_phase_check;
ALTER TABLE issues ADD  CONSTRAINT issues_phase_check CHECK (phase IN (
    'drafting', 'ready',
    'planning', 'implementing',
    'red_planning', 'red_impl',
    'green_planning', 'green_impl',
    'done', 'aborted', 'archived'
));

-- ── 3. Drop columns now subsumed by issue_versions / phase ──────────────────

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
DROP INDEX IF EXISTS idx_issues_status;
ALTER TABLE issues DROP COLUMN IF EXISTS status;
ALTER TABLE issues DROP COLUMN IF EXISTS title;
ALTER TABLE issues DROP COLUMN IF EXISTS description;
CREATE INDEX IF NOT EXISTS idx_issues_phase ON issues(phase);

-- ── 4. comments.version_id ──────────────────────────────────────────────────

ALTER TABLE comments ADD COLUMN IF NOT EXISTS version_id BIGINT REFERENCES issue_versions(id) ON DELETE CASCADE;

UPDATE comments
   SET version_id = v.id
  FROM issue_versions v
 WHERE v.issue_id = comments.issue_id AND v.version_no = 1 AND comments.version_id IS NULL;

ALTER TABLE comments ALTER COLUMN version_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_version ON comments(version_id);

-- ── 5. Drop locks (ownership lives on the issues row now) ───────────────────

DROP TABLE IF EXISTS locks;

-- ── 6. phase_events append-only audit log ───────────────────────────────────

CREATE TABLE IF NOT EXISTS phase_events (
    id         BIGSERIAL PRIMARY KEY,
    issue_id   BIGINT      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    version_id BIGINT      REFERENCES issue_versions(id) ON DELETE SET NULL,
    phase_from TEXT,
    phase_to   TEXT        NOT NULL,
    agent_id   TEXT,
    reason     TEXT,
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phase_events_issue ON phase_events(issue_id);
