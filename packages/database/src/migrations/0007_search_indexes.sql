-- Add trigram indexes for the tokenized ILIKE search baseline.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS library_documents_title_search_fts_idx
  ON library_documents USING gin (to_tsvector('simple', title))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS library_documents_title_search_trgm_idx
  ON library_documents USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS library_blocks_content_search_fts_idx
  ON library_blocks USING gin (to_tsvector('simple', content::text));

CREATE INDEX IF NOT EXISTS library_blocks_content_search_trgm_idx
  ON library_blocks USING gin ((content::text) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS library_properties_value_search_fts_idx
  ON library_properties USING gin (to_tsvector('simple', value::text));

CREATE INDEX IF NOT EXISTS library_properties_value_search_trgm_idx
  ON library_properties USING gin ((value::text) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS courses_title_search_fts_idx
  ON courses USING gin (to_tsvector('simple', title))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS courses_title_search_trgm_idx
  ON courses USING gin (title gin_trgm_ops)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS courses_description_search_fts_idx
  ON courses USING gin (to_tsvector('simple', description))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS courses_description_search_trgm_idx
  ON courses USING gin (description gin_trgm_ops)
  WHERE archived_at IS NULL;
