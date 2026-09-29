-- S1: durable assistant-task acceptance; nullable columns preserve old backups/clients.
ALTER TABLE opening_assistant_candidates
  ADD COLUMN task_accept_client_key TEXT NULL,
  ADD COLUMN task_accept_intent JSONB NULL,
  ADD COLUMN task_result_ref JSONB NULL;

CREATE UNIQUE INDEX opening_assistant_task_accept_key_idx
  ON opening_assistant_candidates (workspace_id, task_accept_client_key)
  WHERE task_accept_client_key IS NOT NULL;

-- Roll back the application first; leaving these nullable columns/index is compatible.
-- If removal is required, disable candidate accepts and export their receipts first,
-- then use a new forward migration to drop the index and the three columns.
-- Never delete migration history or re-open accepted candidates; task rows are retained.
