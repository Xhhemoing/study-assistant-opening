CREATE TABLE IF NOT EXISTS opening_source_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version >= 0),
  page integer NULL CHECK (page IS NULL OR page > 0),
  slide_label text NULL,
  start_ms integer NULL CHECK (start_ms IS NULL OR start_ms >= 0),
  end_ms integer NULL CHECK (end_ms IS NULL OR end_ms >= 0),
  text text NOT NULL CHECK (char_length(text) <= 100000),
  image_object_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_version, page)
);
CREATE INDEX IF NOT EXISTS opening_source_chunks_source_version_idx ON opening_source_chunks (source_id, source_version);
