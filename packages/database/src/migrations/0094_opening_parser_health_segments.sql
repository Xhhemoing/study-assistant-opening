-- OPT-02a: additive worker observations and resumable PDF segments.
-- Rollback: stop new parser/all workers first; keep these tables and cached data.
-- Old workers ignore them. Do NOT DROP on application rollback (see parser README).
CREATE TABLE opening_parser_health (
  worker_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('not_configured','missing_files','preflight_failed','ready')),
  directory_configured boolean NOT NULL,
  directory_exists boolean NOT NULL,
  missing_files jsonb NOT NULL CHECK (jsonb_typeof(missing_files) = 'array'),
  inference_ms integer CHECK (inference_ms >= 0),
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (status <> 'ready' OR (directory_configured AND directory_exists AND missing_files = '[]'::jsonb AND inference_ms IS NOT NULL))
);
CREATE INDEX opening_parser_health_expiry_idx ON opening_parser_health(expires_at);

CREATE TABLE opening_pdf_parse_segments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version >= 1),
  parser_profile text NOT NULL CHECK (length(parser_profile) BETWEEN 1 AND 200),
  page_start integer NOT NULL CHECK (page_start >= 1),
  page_end integer NOT NULL CHECK (page_end >= page_start AND page_end - page_start < 100),
  state text NOT NULL CHECK (state IN ('ready','failed')),
  pages jsonb,
  error_code text CHECK (error_code IN ('conversion_failed','timeout','invalid_output')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, source_version, parser_profile, page_start, page_end),
  CHECK ((state = 'ready' AND pages IS NOT NULL AND jsonb_typeof(pages) = 'array' AND jsonb_array_length(pages) = page_end - page_start + 1 AND error_code IS NULL)
      OR (state = 'failed' AND pages IS NULL AND error_code IS NOT NULL))
);
CREATE INDEX opening_pdf_parse_segments_workspace_idx ON opening_pdf_parse_segments(workspace_id);
