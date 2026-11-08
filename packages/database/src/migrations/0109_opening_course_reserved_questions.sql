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

-- Rollback boundary: retain private rows/table on application rollback; do not
-- drop supply/reservations or modify schema_migrations to make an old runner pass.
-- The inherited 0108 recovery restrictions still apply. Production execution,
-- registry recovery and any destructive rollback require separate approval.
