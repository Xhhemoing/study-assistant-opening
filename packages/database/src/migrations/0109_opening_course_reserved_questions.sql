-- Private course question supply, not a generator or a public library document.
-- Only the reserved-selection repository may read/write question_json and key_json.
-- No historical backfill: an empty exposure ledger is NOT proof of non-exposure.
CREATE TABLE opening_course_reserved_questions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  source_versions jsonb NOT NULL CHECK (jsonb_typeof(source_versions) = 'object' AND source_versions <> '{}'::jsonb),
  identity_ref_id uuid NOT NULL,
  identity_json jsonb NOT NULL CHECK (jsonb_typeof(identity_json) = 'object'),
  family_id text NOT NULL CHECK (char_length(family_id) BETWEEN 1 AND 100),
  content_ref_id uuid NOT NULL,
  key_ref_id uuid NOT NULL,
  question_json jsonb NOT NULL CHECK (jsonb_typeof(question_json) = 'object'),
  interaction_json jsonb NOT NULL CHECK (jsonb_typeof(interaction_json) = 'object'),
  key_json jsonb NOT NULL CHECK (jsonb_typeof(key_json) = 'object'),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','reserved','issued','revoked')),
  reservation_key text CHECK (char_length(reservation_key) BETWEEN 8 AND 200),
  reserved_activity_id uuid REFERENCES opening_teaching_activities(id),
  reserved_at timestamptz,
  issued_item_version_id uuid REFERENCES opening_learning_item_versions(id),
  issued_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_user_id, identity_ref_id),
  UNIQUE (workspace_id, owner_user_id, content_ref_id),
  UNIQUE (workspace_id, owner_user_id, key_ref_id),
  UNIQUE (workspace_id, owner_user_id, reservation_key),
  UNIQUE (issued_item_version_id),
  FOREIGN KEY (workspace_id, course_id) REFERENCES courses(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, requirement_id) REFERENCES course_requirements(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT opening_course_reserved_questions_reservation CHECK (
    (reservation_key IS NULL AND reserved_activity_id IS NULL AND reserved_at IS NULL)
    OR (reservation_key IS NOT NULL AND reserved_activity_id IS NOT NULL AND reserved_at IS NOT NULL)
  ),
  CONSTRAINT opening_course_reserved_questions_issuance CHECK (
    (issued_item_version_id IS NULL) = (issued_at IS NULL)
    AND (issued_at IS NULL OR (reserved_at IS NOT NULL AND issued_at >= reserved_at))
  ),
  CONSTRAINT opening_course_reserved_questions_state CHECK (
    (state = 'available' AND reserved_at IS NULL AND issued_at IS NULL AND revoked_at IS NULL)
    OR (state = 'reserved' AND reserved_at IS NOT NULL AND issued_at IS NULL AND revoked_at IS NULL)
    OR (state = 'issued' AND reserved_at IS NOT NULL AND issued_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT opening_course_reserved_questions_identity CHECK (
    identity_json->>'identityRefId' IS NOT NULL
    AND identity_json->>'identityRefId' = identity_ref_id::text
    AND key_json->>'keyRefId' IS NOT NULL
    AND key_json->>'keyRefId' = key_ref_id::text
    AND key_json->'identity' IS NOT NULL
    AND key_json->'identity' = identity_json
  )
);
CREATE INDEX opening_course_reserved_questions_supply_idx
  ON opening_course_reserved_questions (workspace_id, owner_user_id, course_id, requirement_id, requirement_revision, state);

-- The repository binds immutable content and identity before any reservation.
CREATE FUNCTION opening_reserved_question_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','reservation_key','reserved_activity_id','reserved_at','issued_item_version_id','issued_at','revoked_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','reservation_key','reserved_activity_id','reserved_at','issued_item_version_id','issued_at','revoked_at']) THEN
    RAISE EXCEPTION 'reserved question content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_reserved_question_immutable BEFORE UPDATE ON opening_course_reserved_questions FOR EACH ROW EXECUTE FUNCTION opening_reserved_question_immutable();

-- Private exposure facts retain old source versions and UUID-independent exact
-- conditions. NULL/partial exact_content never establishes unseen eligibility.
CREATE TABLE opening_course_question_exposures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface_key text NOT NULL CHECK (char_length(surface_key) BETWEEN 1 AND 240),
  kind text NOT NULL CHECK (kind IN ('teaching','example','hint','presented')),
  identity_ref_id uuid,
  exact_content jsonb CHECK (exact_content IS NULL OR jsonb_typeof(exact_content) = 'object'),
  family_id text,
  source_versions jsonb NOT NULL CHECK (jsonb_typeof(source_versions) = 'object'),
  item_version_id uuid REFERENCES opening_learning_item_versions(id),
  history_revision bigint NOT NULL CHECK (history_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_user_id, surface_key)
);
CREATE TABLE opening_course_question_exposure_coverage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protocol text NOT NULL CHECK (protocol = 'course-question-exposure-1'),
  history_revision bigint NOT NULL CHECK (history_revision >= 0),
  complete boolean NOT NULL DEFAULT false,
  invalidated boolean NOT NULL DEFAULT false,
  covered_surface_count bigint NOT NULL CHECK (covered_surface_count >= 0),
  PRIMARY KEY (workspace_id, owner_user_id)
);
CREATE INDEX opening_course_question_exposures_history_idx
  ON opening_course_question_exposures (workspace_id, owner_user_id, history_revision);

-- Scope is a storage invariant, not merely a property of parsed server input.
-- Historical source versions need not be current; do not erase them on replacement.
CREATE FUNCTION opening_course_question_exposure_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'question exposure scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='opening_course_question_exposures' THEN
    IF NEW.item_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opening_learning_item_versions WHERE id=NEW.item_version_id
        AND workspace_id=NEW.workspace_id AND owner_user_id=NEW.owner_user_id
    ) THEN
      RAISE EXCEPTION 'question exposure item scope mismatch' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(NEW.source_versions) ref WHERE
      jsonb_typeof(ref.value)<>'number' OR ref.value::text !~ '^(0|[1-9][0-9]*)$'
      OR ref.key !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'question exposure source version invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_course_question_exposures_scope BEFORE INSERT OR UPDATE ON opening_course_question_exposures
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_exposure_scope();
CREATE TRIGGER opening_course_question_exposure_coverage_scope BEFORE INSERT OR UPDATE ON opening_course_question_exposure_coverage
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_exposure_scope();
CREATE FUNCTION opening_course_question_exposure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'question exposure history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_course_question_exposure_immutable BEFORE UPDATE ON opening_course_question_exposures
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_exposure_immutable();

-- Only workspace creation seeds provenance. An ordinary caller/scanner cannot
-- insert a coverage row to retrofit a pre-migration workspace. No backfill.
CREATE FUNCTION opening_course_question_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF pg_trigger_depth()<>2 OR NEW.protocol<>'course-question-exposure-1'
      OR NEW.history_revision<>0 OR NEW.complete OR NEW.invalidated OR NEW.covered_surface_count<>0 THEN
      RAISE EXCEPTION 'coverage genesis requires workspace creation' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.workspace_id,NEW.owner_user_id,NEW.protocol) IS DISTINCT FROM (OLD.workspace_id,OLD.owner_user_id,OLD.protocol) THEN
      RAISE EXCEPTION 'coverage scope is immutable' USING ERRCODE='23514';
    END IF;
    -- Never let a scanner clear a deletion gap or promote invalidated history.
    NEW.invalidated := OLD.invalidated OR NEW.invalidated;
    IF NEW.invalidated THEN NEW.complete := false; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_course_question_coverage_guard BEFORE INSERT OR UPDATE ON opening_course_question_exposure_coverage
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_coverage_guard();
CREATE FUNCTION opening_course_question_coverage_genesis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,complete,invalidated,covered_surface_count)
    VALUES(NEW.id,NEW.owner_user_id,'course-question-exposure-1',0,false,false,0);
  RETURN NEW;
END $$;
CREATE TRIGGER opening_course_question_coverage_genesis AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_coverage_genesis();

-- No dynamic SQL or extra privileges: only these explicit historical surfaces.
-- The source BEFORE DELETE trigger marks its workspace before cascade removes
-- chunks, whose parent lookup may no longer resolve during the cascade.
CREATE FUNCTION opening_course_question_history_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_workspace uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  old_workspace := (to_jsonb(OLD)->>'workspace_id')::uuid;
  IF TG_TABLE_NAME='opening_source_chunks' THEN
    SELECT workspace_id INTO old_workspace FROM opening_sources WHERE id=OLD.source_id;
  END IF;
  UPDATE opening_course_question_exposure_coverage SET invalidated=true,complete=false WHERE workspace_id=old_workspace;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF blocks ON library_revisions
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF text,image_object_key ON opening_source_chunks
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE ON opening_sources
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF text,help_input_snapshot ON opening_turns
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE ON opening_help_exposures
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE ON opening_learning_item_versions
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();

CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF content ON library_blocks
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF stem_snapshot ON opening_problem_refs
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
-- Checkpoint edits are conservatively treated as lost historical presentation;
-- frequent checkpoint saves can therefore leave coverage permanently unknown.
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF checkpoint_json ON opening_teaching_activities
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE OR UPDATE OF answer ON opening_learning_observations
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();
CREATE TRIGGER opening_course_question_history_invalidate BEFORE DELETE ON opening_course_question_exposures
  FOR EACH ROW EXECUTE FUNCTION opening_course_question_history_invalidate();

-- These row triggers preserve deletion gaps; they do NOT serialize every
-- surface INSERT against scan/reserve. Do not claim concurrency-safe unseen
-- until each writer acquires history -> coverage -> business locks at entry.
-- Taking history from a row UPDATE trigger would invert that lock order.
-- Genesis is NOT completeness. Only the server's full-history scanner
-- plus all presentation/help writers may establish coverage under the history lock.
-- Readers require protocol/owner/workspace and the CURRENT workspace watermark;
-- this storage row alone (even complete=true) is not a coverage proof. These tables
-- are not ordinary backup inventory. Privacy deletion remains with the existing
-- owner-authorized delete path; source replacement never deletes exposure history.

-- Rollback boundary: retain private rows/table on application rollback; do not
-- drop supply/reservations or modify schema_migrations to make an old runner pass.
-- The inherited 0108 recovery restrictions still apply. Production execution,
-- registry recovery and any destructive rollback require separate approval.
