CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check CHECK (kind IN (
  'parse','tutor','retest','remind','build-course-knowledge','parse-media','extract-study-actions','compile-teaching-unit','index-source'
));

CREATE TABLE opening_source_embeddings (
  chunk_id uuid NOT NULL REFERENCES opening_source_chunks(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  source_version integer NOT NULL,
  model_key text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  text text NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model_key, segment_index),
  CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX opening_source_embeddings_source_model_idx
  ON opening_source_embeddings(source_id, source_version, model_key, dimensions);
