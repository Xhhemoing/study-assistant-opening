-- 0004_identity_repair.sql
-- Corrective safety checks for databases that already recorded legacy 0003.
-- This migration cannot recover data deleted by a prior 0003 execution.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workspaces w
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id)
  ) THEN
    RAISE EXCEPTION 'IDENTITY_ORPHAN_WORKSPACES: verified owner mapping required'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_delete;
ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_update;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_owner_user_id_fkey'
      AND conrelid = 'workspaces'::regclass
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_owner_user_id_fkey
      FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_user_uidx
  ON workspaces (owner_user_id);
