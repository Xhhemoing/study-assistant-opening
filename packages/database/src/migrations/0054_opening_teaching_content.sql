-- V2-05: TeachingUnit + ActivitySpec metadata (ADR D2).
-- Sole teaching body remains library_documents / library_blocks / library_revisions.
-- No denorm columns on opening_teaching_activities (JOIN via activity_specs).
-- No ActivitySpec history table (M1: history via library revision_number).
-- No opening_teaching_answer_refs (derive answerRef from blocks at read time).

CREATE TABLE opening_teaching_units (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  -- library_documents uniqueness is PRIMARY KEY (id) only (0001_library.sql);
  -- no UNIQUE (workspace_id, id) on library_documents, so FK is id-scoped.
  document_id UUID NOT NULL REFERENCES library_documents(id),
  current_revision_number INTEGER NOT NULL DEFAULT 0 CHECK (current_revision_number >= 0),
  goals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (verification_status IN (
      'unchecked', 'structure_ok', 'needs_check', 'verified', 'rejected', 'stale'
    )),
  generation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX opening_teaching_units_owner_idx
  ON opening_teaching_units (workspace_id, owner_user_id, updated_at DESC);

CREATE TABLE opening_teaching_activity_specs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id UUID NOT NULL
    REFERENCES opening_teaching_activities(id) ON DELETE CASCADE,
  teaching_unit_id UUID NOT NULL
    REFERENCES opening_teaching_units(id),
  document_id UUID NOT NULL REFERENCES library_documents(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  block_order JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  goals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (verification_status IN (
      'unchecked', 'structure_ok', 'needs_check', 'verified', 'rejected', 'stale'
    )),
  generation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, activity_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX opening_teaching_activity_specs_unit_idx
  ON opening_teaching_activity_specs (workspace_id, teaching_unit_id);

-- Rollback notes (manual; do not DROP user data in product rollback):
-- 1. Feature-flag off publish/getClientInit; retain rows.
-- 2. Old library revisions remain readable.
-- 3. DROP INDEX opening_teaching_activity_specs_unit_idx;
-- 4. DROP TABLE opening_teaching_activity_specs;
-- 5. DROP INDEX opening_teaching_units_owner_idx;
-- 6. DROP TABLE opening_teaching_units;
