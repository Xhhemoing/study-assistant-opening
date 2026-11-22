CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE workspaces ADD CONSTRAINT v3_workspaces_id_owner_key UNIQUE (id, owner_user_id);

CREATE TABLE v3_bitemporal_misconception_edges (
  revision_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edge_id uuid NOT NULL,
  course_id uuid,
  concept_key text NOT NULL,
  misconception_code text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'verified', 'learner_reported', 'retracted', 'superseded')),
  origin text NOT NULL CHECK (origin IN ('public_try_handoff', 'system_diagnosis', 'learner_correction')),
  learner_disposition text CHECK (learner_disposition IN ('disputed', 'clarified', 'resolved_self_report')),
  evidence_attempt_ids uuid[] NOT NULL DEFAULT '{}',
  privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
  valid_range tstzrange NOT NULL CHECK (NOT isempty(valid_range) AND lower_inc(valid_range) AND NOT upper_inc(valid_range)),
  tx_range tstzrange NOT NULL CHECK (NOT isempty(tx_range) AND lower_inc(tx_range) AND NOT upper_inc(tx_range)),
  prior_revision_id uuid,
  CONSTRAINT v3_misconception_learner_revision CHECK (
    (status = 'learner_reported') = (origin = 'learner_correction')
    AND (status = 'learner_reported') = (learner_disposition IS NOT NULL)
    AND (status <> 'learner_reported' OR prior_revision_id IS NOT NULL)
  ),
  CONSTRAINT v3_misconception_public_try_candidate CHECK (
    origin <> 'public_try_handoff' OR (
      status = 'candidate' AND prior_revision_id IS NULL AND course_id IS NULL AND cardinality(evidence_attempt_ids) = 0
    )
  ),
  CONSTRAINT v3_misconception_workspace_owner FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspaces(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT v3_misconception_revision_scope UNIQUE (workspace_id, owner_user_id, edge_id, revision_id),
  CONSTRAINT v3_misconception_course_scope FOREIGN KEY (workspace_id, course_id)
    REFERENCES courses(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT v3_misconception_prior_scope FOREIGN KEY (workspace_id, owner_user_id, edge_id, prior_revision_id)
    REFERENCES v3_bitemporal_misconception_edges(workspace_id, owner_user_id, edge_id, revision_id),
  CONSTRAINT v3_misconception_no_overlap
    EXCLUDE USING gist (workspace_id WITH =, edge_id WITH =, valid_range WITH &&, tx_range WITH &&),
  CONSTRAINT v3_misconception_single_workspace EXCLUDE USING gist (edge_id WITH =, workspace_id WITH <>),
  CONSTRAINT v3_misconception_single_owner EXCLUDE USING gist (edge_id WITH =, owner_user_id WITH <>),
  CONSTRAINT v3_misconception_single_course EXCLUDE USING gist (edge_id WITH =, course_id WITH <>),
  CONSTRAINT v3_misconception_course_nullability EXCLUDE USING gist (edge_id WITH =, ((course_id IS NULL)::integer) WITH <>)
);

CREATE FUNCTION v3_misconception_close_tx_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Referential actions run after the owning parent row is gone.
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.owner_user_id)
      OR (OLD.course_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM courses WHERE workspace_id = OLD.workspace_id AND id = OLD.course_id
      ))
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Misconception revisions cannot be deleted directly' USING ERRCODE = '23514';
  END IF;
  IF NOT upper_inf(OLD.tx_range)
    OR upper_inf(NEW.tx_range)
    OR NOT isfinite(upper(NEW.tx_range))
    OR lower(NEW.tx_range) IS DISTINCT FROM lower(OLD.tx_range)
    OR (to_jsonb(NEW) - 'tx_range') IS DISTINCT FROM (to_jsonb(OLD) - 'tx_range')
  THEN
    RAISE EXCEPTION 'Misconception revisions can only close an open transaction range'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER v3_misconception_close_tx_only
  BEFORE UPDATE OR DELETE ON v3_bitemporal_misconception_edges
  FOR EACH ROW EXECUTE FUNCTION v3_misconception_close_tx_only();

CREATE TABLE v3_learner_context_blocks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rendered_markdown text NOT NULL CHECK (octet_length(rendered_markdown) <= 2048),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 2048 AND byte_length = octet_length(rendered_markdown)),
  revision integer NOT NULL CHECK (revision > 0),
  privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
  updated_at timestamptz NOT NULL,
  CONSTRAINT v3_learner_context_workspace_owner FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspaces(id, owner_user_id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, owner_user_id)
);

CREATE FUNCTION v3_invalidate_misconception_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE id = affected_workspace_id) THEN
    -- The revision lock is already held. Use only the cache lock here so a cascade
    -- or direct SQL mutation cannot wait for a workspace lock held by a revision writer.
    PERFORM pg_advisory_xact_lock(hashtextextended('v3:learner-context:' || affected_workspace_id::text, 0));
    DELETE FROM v3_learner_context_blocks WHERE workspace_id = affected_workspace_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER v3_invalidate_misconception_context
  AFTER INSERT OR UPDATE OR DELETE ON v3_bitemporal_misconception_edges
  FOR EACH ROW EXECUTE FUNCTION v3_invalidate_misconception_context();

CREATE TABLE v3_try_misconception_handoff_receipts (
  receipt_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  edge_id uuid NOT NULL,
  initial_revision_id uuid NOT NULL,
  redeemed_at timestamptz NOT NULL,
  CONSTRAINT v3_try_receipt_workspace_owner FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspaces(id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT v3_try_misconception_initial_scope FOREIGN KEY (workspace_id, owner_user_id, edge_id, initial_revision_id)
    REFERENCES v3_bitemporal_misconception_edges(workspace_id, owner_user_id, edge_id, revision_id) ON DELETE CASCADE
);

-- Roll back the application first and retain these tables to preserve learner history and receipt claims.
-- Before retiring the schema, stop writes and export the three tables. Then drop the receipt table,
-- context-block table, edge table, v3_misconception_close_tx_only() and v3_invalidate_misconception_context().
-- Drop v3_workspaces_id_owner_key after dropping the dependent tables.
-- Keep the shared extension installed.
