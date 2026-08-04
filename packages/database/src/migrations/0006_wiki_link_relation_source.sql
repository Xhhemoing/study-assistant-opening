-- Distinguish automatically indexed wiki links from user-authored relations.
ALTER TABLE library_relations
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

ALTER TABLE library_relations
  DROP CONSTRAINT IF EXISTS library_relations_source_check;

ALTER TABLE library_relations
  ADD CONSTRAINT library_relations_source_check
  CHECK (source IN ('manual', 'wiki-link'));
