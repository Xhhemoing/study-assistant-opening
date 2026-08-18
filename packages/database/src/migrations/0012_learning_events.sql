-- 0012_learning_events.sql
-- Append-only personal learning events. Envelope columns are typed;
-- type-specific details live in Zod-validated payload JSONB.

CREATE TABLE IF NOT EXISTS learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('attempt', 'review', 'correction')),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) >= 8 AND char_length(idempotency_key) <= 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  content_id uuid NULL,
  content_version integer NULL CHECK (content_version IS NULL OR content_version > 0),
  syllabus_point_id uuid NULL,
  corrects_event_id uuid NULL REFERENCES learning_events (id),
  payload jsonb NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, owner_user_id, idempotency_key),
  CHECK (
    (type = 'attempt'
      AND content_id IS NOT NULL
      AND content_version IS NOT NULL
      AND syllabus_point_id IS NOT NULL
      AND corrects_event_id IS NULL)
    OR (type = 'review'
      AND content_id IS NOT NULL
      AND content_version IS NOT NULL
      AND corrects_event_id IS NULL)
    OR (type = 'correction' AND corrects_event_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS learning_events_workspace_occurred_idx
  ON learning_events (workspace_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION learning_event_workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_owner uuid;
  target_workspace uuid;
BEGIN
  SELECT owner_user_id INTO workspace_owner FROM workspaces WHERE id = NEW.workspace_id;
  IF workspace_owner IS NULL THEN
    RAISE EXCEPTION 'workspace % not found', NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF workspace_owner <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'learning event owner must match workspace owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.corrects_event_id IS NOT NULL THEN
    SELECT workspace_id INTO target_workspace FROM learning_events WHERE id = NEW.corrects_event_id;
    IF target_workspace IS NULL THEN
      RAISE EXCEPTION 'corrected event % not found', NEW.corrects_event_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF target_workspace <> NEW.workspace_id THEN
      RAISE EXCEPTION 'correction must stay in the same workspace'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS learning_events_workspace_guard ON learning_events;
CREATE TRIGGER learning_events_workspace_guard
  BEFORE INSERT ON learning_events
  FOR EACH ROW
  EXECUTE FUNCTION learning_event_workspace_guard();

CREATE OR REPLACE FUNCTION learning_events_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'learning_events are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS learning_events_no_update ON learning_events;
CREATE TRIGGER learning_events_no_update
  BEFORE UPDATE ON learning_events
  FOR EACH ROW
  EXECUTE FUNCTION learning_events_reject_update();
