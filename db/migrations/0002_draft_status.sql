-- Migration 0002: add 'draft' to issues.status CHECK constraint.
-- Safe on both fresh databases (0001 already includes 'draft') and existing
-- installations that only have 'open', 'closed', 'archived'.
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
ALTER TABLE issues ADD CONSTRAINT issues_status_check
  CHECK (status IN ('open', 'closed', 'archived', 'draft'));
