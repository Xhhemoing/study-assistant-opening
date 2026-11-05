-- Append-only manual confirmations; no existing schema or automatic rules change.
CREATE TABLE opening_knowledge_confirmations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  node_label text NOT NULL,
  node_kind text NOT NULL CHECK (node_kind IN ('chapter', 'concept', 'procedure', 'problem_type')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  graph_version_before integer NOT NULL CHECK (graph_version_before >= 0),
  graph_version_after integer NOT NULL CHECK (graph_version_after = graph_version_before + 1),
  source_versions jsonb NOT NULL CHECK (jsonb_typeof(source_versions) = 'object'),
  evidence_chunk_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_chunk_ids) = 'array' AND jsonb_array_length(evidence_chunk_ids) > 0),
  UNIQUE (workspace_id, course_id, graph_version_after)
);
CREATE INDEX opening_knowledge_confirmations_node_idx
  ON opening_knowledge_confirmations (workspace_id, owner_user_id, course_id, node_id, graph_version_after DESC);

-- Rollback: DROP TABLE opening_knowledge_confirmations;
-- No data needs migrating back. Safe to apply before releasing application code.
