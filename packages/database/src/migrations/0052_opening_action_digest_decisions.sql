-- P04: durable accept/reject/superseded overlay for action-digest candidates.
-- Pending extract rows stay on opening_jobs (0051 extract-study-actions); this table
-- stores only durable decisions so Experience can swap createInMemoryActionCandidateStore.
CREATE TABLE opening_action_digest_decisions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL,
  dedupe_key TEXT NOT NULL
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 240),
  title TEXT NOT NULL
    CHECK (char_length(title) BETWEEN 1 AND 500),
  minutes INTEGER NOT NULL
    CHECK (minutes > 0 AND minutes <= 1440),
  due_at TIMESTAMPTZ,
  priority DOUBLE PRECISION NOT NULL,
  source_ids UUID[] NOT NULL DEFAULT '{}',
  needs_confirmation BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL
    CHECK (status IN ('accepted', 'rejected', 'superseded')),
  client_key TEXT
    CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 8 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT opening_action_digest_decisions_id_matches_candidate
    CHECK (id = candidate_id),
  UNIQUE (workspace_id, owner_user_id, candidate_id)
);

CREATE INDEX opening_action_digest_decisions_owner_idx
  ON opening_action_digest_decisions (workspace_id, owner_user_id, updated_at DESC);

CREATE INDEX opening_action_digest_decisions_dedupe_idx
  ON opening_action_digest_decisions (workspace_id, owner_user_id, dedupe_key);

CREATE UNIQUE INDEX opening_action_digest_decisions_client_key_uidx
  ON opening_action_digest_decisions (workspace_id, owner_user_id, client_key)
  WHERE client_key IS NOT NULL;

-- Rollback:
-- DROP TABLE opening_action_digest_decisions;
