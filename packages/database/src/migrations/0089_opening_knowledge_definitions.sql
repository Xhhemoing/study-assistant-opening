-- Server-private definitions preserve knowledge identity when a parser replaces chunk UUIDs.
-- Revert application writes first; keep this nullable-free additive column on rollback.
ALTER TABLE opening_course_knowledge
  ADD COLUMN node_definitions jsonb NOT NULL DEFAULT '{}'::jsonb;
