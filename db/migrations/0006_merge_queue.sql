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

-- Migration 0006: merge daemon queue + per-task step checkpoints.
--
-- Merge daemon queue and step checkpoints. One queue, one task type, one consumer.
-- See scripts/lib/merge-runtime.ts for the TypeScript runtime that drives these
-- tables.
--
-- merge_tasks: one row per merge enqueued by a worker. Idempotency-keyed on
-- 'merge:<issueId>'. State machine: pending -> running -> (completed | failed).
-- Failed is terminal; no automatic retries. Single-consumer assumption means
-- re-claiming 'running' rows after a daemon crash is safe — the handler is
-- resumable via step replay.
--
-- merge_task_steps: one row per ctx.step / completeStep checkpoint. The
-- (name, seq) shape supports both single-shot checkpoints (seq=0 for named steps)
-- and multi-shot logs (seq=0,1,2,... for repair-agent messages under name='message').

CREATE TABLE IF NOT EXISTS merge_tasks (
    id              BIGSERIAL   PRIMARY KEY,
    idempotency_key TEXT        NOT NULL UNIQUE,
    params          JSONB       NOT NULL,
    state           TEXT        NOT NULL
                    CHECK (state IN ('pending','running','completed','failed')),
    attempts        INT         NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS merge_tasks_active
    ON merge_tasks (id)
    WHERE state IN ('pending','running');

CREATE TABLE IF NOT EXISTS merge_task_steps (
    task_id      BIGINT      NOT NULL REFERENCES merge_tasks(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    seq          INT         NOT NULL,
    value        JSONB       NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, name, seq)
);
