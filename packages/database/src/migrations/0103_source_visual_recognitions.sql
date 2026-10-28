-- Derived page recognition cache. Original source bytes and learning evidence remain authoritative.
-- Rollback: disable visual ingestion first; retain this table to preserve paid results/retry identity.
CREATE TABLE opening_source_visual_recognitions (
  source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version >= 0),
  physical_page integer NOT NULL CHECK (physical_page BETWEEN 1 AND 2000),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  model_snapshot jsonb NOT NULL CHECK (jsonb_typeof(model_snapshot) = 'object'),
  operation_id text NOT NULL UNIQUE,
  image_object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, source_version, physical_page)
);
CREATE INDEX opening_source_visual_recognitions_workspace_idx ON opening_source_visual_recognitions(workspace_id);
