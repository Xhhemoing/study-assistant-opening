-- DL5: nullable client_key on opening_tasks for quick-add idempotency (workspace+owner).
-- Retest/assistant acceptance keep their own client-key receipts; this column is for candidateId=null writes.
ALTER TABLE opening_tasks
  ADD COLUMN client_key TEXT NULL
  CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 8 AND 200);

CREATE UNIQUE INDEX opening_tasks_workspace_owner_client_key_uidx
  ON opening_tasks (workspace_id, owner_user_id, client_key)
  WHERE client_key IS NOT NULL;

-- Rollback: DROP INDEX opening_tasks_workspace_owner_client_key_uidx;
-- ALTER TABLE opening_tasks DROP COLUMN client_key;
