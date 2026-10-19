-- Query tools remain read-only. The application persists prepared reply provenance here.
ALTER TABLE opening_turns ADD COLUMN query_system boolean NOT NULL DEFAULT false;
ALTER TABLE opening_turns ADD COLUMN system_query jsonb;
ALTER TABLE opening_turns ADD CONSTRAINT opening_turns_system_query_size_check
  CHECK (system_query IS NULL OR (query_system AND role='assistant' AND jsonb_typeof(system_query)='object' AND octet_length(system_query::text)<=131072));

-- A deterministic query is not a provider request and must not invent a paid-call reservation.
CREATE TABLE opening_query_ephemeral_provenance (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  privacy_epoch bigint NOT NULL CHECK (privacy_epoch>=0),
  context_source_refs jsonb NOT NULL CHECK (jsonb_typeof(context_source_refs)='array'
    AND jsonb_array_length(context_source_refs)<=256 AND octet_length(context_source_refs::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  CONSTRAINT opening_query_ephemeral_provenance_scope_request_uidx UNIQUE(workspace_id,owner_user_id,request_id)
);
CREATE INDEX opening_query_ephemeral_provenance_expiry_idx ON opening_query_ephemeral_provenance(expires_at);
-- Roll back application/OPENING_SYSTEM_QUERY first; retain columns/table and prepared lineage.
-- Old application code ignores new columns and treats unknown query-provenance ids as unverifiable.
-- Before starting an old worker: stop new submissions/workers, cancel queued query jobs and
-- finish/cancel running query jobs. An old worker does not understand query_system intent.
