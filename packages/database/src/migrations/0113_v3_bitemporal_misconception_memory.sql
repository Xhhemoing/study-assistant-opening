CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE workspaces ADD CONSTRAINT v3_workspaces_id_owner_key UNIQUE (id, owner_user_id);

CREATE TABLE v3_bitemporal_misconception_edges (
  revision_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
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
  valid_range tstzrange NOT NULL CHECK (NOT isempty(valid_range) AND lower_inc(valid_range) AND NOT upper_inc(valid_range)
    AND lower(valid_range) < 'infinity'::timestamptz),
  tx_range tstzrange NOT NULL CHECK (NOT isempty(tx_range) AND lower_inc(tx_range) AND NOT upper_inc(tx_range)
    AND lower(tx_range) < 'infinity'::timestamptz AND (upper_inf(tx_range) OR isfinite(upper(tx_range)))),
  prior_revision_id uuid,
  CONSTRAINT v3_misconception_no_self_predecessor CHECK (prior_revision_id IS DISTINCT FROM revision_id),
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

CREATE FUNCTION v3_reject_misconception_revision_cycles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A new cycle must include a newly inserted revision because predecessors are immutable.
  IF EXISTS (
    WITH RECURSIVE lineage(start_id, next_id) AS (
      SELECT revision_id, prior_revision_id FROM inserted WHERE prior_revision_id IS NOT NULL
      UNION
      SELECT l.start_id, e.prior_revision_id
        FROM lineage l JOIN v3_bitemporal_misconception_edges e ON e.revision_id = l.next_id
        WHERE l.next_id <> l.start_id AND e.prior_revision_id IS NOT NULL
    )
    SELECT 1 FROM lineage WHERE start_id = next_id
  ) THEN
    RAISE EXCEPTION 'Misconception revision predecessors must be acyclic'
      USING ERRCODE = '23514', CONSTRAINT = 'v3_misconception_acyclic_predecessors';
  END IF;
  -- A closed transaction range cannot change, so accepted predecessors stay closed.
  IF EXISTS (
    SELECT 1 FROM inserted child
    JOIN v3_bitemporal_misconception_edges parent ON parent.revision_id = child.prior_revision_id
    WHERE upper_inf(parent.tx_range) OR NOT isfinite(upper(parent.tx_range))
      OR lower(child.tx_range) < upper(parent.tx_range)
  ) THEN
    RAISE EXCEPTION 'Misconception revision precedes the closure of its predecessor'
      USING ERRCODE = '23514', CONSTRAINT = 'v3_misconception_predecessor_chronology';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER v3_reject_misconception_revision_cycles
  AFTER INSERT ON v3_bitemporal_misconception_edges
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION v3_reject_misconception_revision_cycles();

CREATE FUNCTION v3_misconception_close_tx_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Referential actions run after the owning parent row is gone.
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
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
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  rendered_markdown text NOT NULL CHECK (octet_length(rendered_markdown) <= 2048),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 2048 AND byte_length = octet_length(rendered_markdown)),
  revision integer NOT NULL CHECK (revision > 0),
  invalidated boolean NOT NULL DEFAULT false,
  privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
  updated_at timestamptz NOT NULL,
  restore_cutoff_seq bigint,
  CONSTRAINT v3_learner_context_blocks_restore_cutoff_check
    CHECK (restore_cutoff_seq > 0),
  CONSTRAINT v3_learner_context_workspace_owner FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspaces(id, owner_user_id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, owner_user_id)
);

CREATE FUNCTION v3_invalidate_misconception_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces WHERE id = affected_workspace_id) THEN
    -- Invalidation runs after workspace, course and revision locks, before commit.
    -- Repository writers flush it only after their final revision mutation.
    PERFORM pg_advisory_xact_lock(hashtextextended('v3:learner-context:' || affected_workspace_id::text, 0));
    UPDATE v3_learner_context_blocks SET invalidated = true, rendered_markdown = '', byte_length = 0
      WHERE workspace_id = affected_workspace_id AND NOT invalidated;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER v3_invalidate_misconception_context
  AFTER INSERT OR UPDATE OR DELETE ON v3_bitemporal_misconception_edges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION v3_invalidate_misconception_context();

CREATE SEQUENCE v3_try_misconception_handoff_seq AS bigint MINVALUE 1;

CREATE TABLE v3_try_misconception_handoff_receipts (
  receipt_id uuid PRIMARY KEY,
  original_workspace_id uuid NOT NULL,
  original_owner_user_id uuid NOT NULL,
  original_edge_id uuid NOT NULL,
  original_initial_revision_id uuid NOT NULL,
  redeemed_privacy_epoch integer NOT NULL CHECK (redeemed_privacy_epoch >= 0),
  workspace_id uuid,
  owner_user_id uuid,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  edge_id uuid,
  initial_revision_id uuid,
  redeemed_at timestamptz NOT NULL,
  CONSTRAINT v3_try_receipt_attachment CHECK (
    (workspace_id IS NULL AND owner_user_id IS NULL AND edge_id IS NULL AND initial_revision_id IS NULL)
    OR (workspace_id IS NOT NULL AND workspace_id = original_workspace_id
      AND owner_user_id IS NOT NULL AND owner_user_id = original_owner_user_id
      AND edge_id IS NOT NULL AND edge_id = original_edge_id
      AND initial_revision_id IS NOT NULL AND initial_revision_id = original_initial_revision_id)
  ),
  -- The edge cascade clears the whole attachment. Check workspace ownership after that action.
  CONSTRAINT v3_try_receipt_workspace_owner FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspaces(id, owner_user_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT v3_try_misconception_initial_scope FOREIGN KEY (workspace_id, owner_user_id, edge_id, initial_revision_id)
    REFERENCES v3_bitemporal_misconception_edges(workspace_id, owner_user_id, edge_id, revision_id)
    ON DELETE SET NULL (workspace_id, owner_user_id, edge_id, initial_revision_id)
);

CREATE FUNCTION v3_protect_try_handoff_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
    OR NEW.original_workspace_id IS DISTINCT FROM OLD.original_workspace_id
    OR NEW.original_owner_user_id IS DISTINCT FROM OLD.original_owner_user_id
    OR NEW.original_edge_id IS DISTINCT FROM OLD.original_edge_id
    OR NEW.original_initial_revision_id IS DISTINCT FROM OLD.original_initial_revision_id
    OR NEW.redeemed_privacy_epoch IS DISTINCT FROM OLD.redeemed_privacy_epoch
    OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
  THEN
    RAISE EXCEPTION 'Try misconception receipt provenance cannot change'
      USING ERRCODE = '23514', CONSTRAINT = 'v3_try_receipt_immutable_provenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER v3_protect_try_handoff_receipt
  BEFORE UPDATE ON v3_try_misconception_handoff_receipts
  FOR EACH ROW EXECUTE FUNCTION v3_protect_try_handoff_receipt();

-- Roll back the application first and retain these tables to preserve learner history and receipt claims.
-- Before retiring the schema, stop writes and export the three tables. Then drop the receipt table,
-- context-block table, edge table, v3_misconception_close_tx_only(), v3_invalidate_misconception_context()
-- v3_reject_misconception_revision_cycles() and v3_protect_try_handoff_receipt().
-- DROP SEQUENCE v3_try_misconception_handoff_seq;
-- Drop v3_workspaces_id_owner_key after dropping the dependent tables.
-- Keep the shared extension installed.
