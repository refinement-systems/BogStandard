-- Initial BogStandard schema. Single migration.
--
-- Run by scripts/setup.ts against an empty database.

CREATE TABLE IF NOT EXISTS issues (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed', 'archived', 'draft')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    parent_id   BIGINT REFERENCES issues(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS comments (
    id         BIGSERIAL PRIMARY KEY,
    issue_id   BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'note',
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dependencies (
    blocker_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    blocked_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS locks (
    issue_id   BIGINT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    agent_id   TEXT NOT NULL,
    branch     TEXT,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row project-wide agent config. The CHECK enforces one row only.
CREATE TABLE IF NOT EXISTS agent_config (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    agent_id    TEXT NOT NULL,
    description TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_status   ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
CREATE INDEX IF NOT EXISTS idx_issues_parent   ON issues(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue  ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_deps_blocker    ON dependencies(blocker_id);
CREATE INDEX IF NOT EXISTS idx_deps_blocked    ON dependencies(blocked_id);
