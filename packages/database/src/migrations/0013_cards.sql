-- 0013_cards.sql
-- Shared card identity + one personal review state per owner+card.

CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  front text NOT NULL CHECK (char_length(front) > 0),
  back text NOT NULL CHECK (char_length(back) > 0),
  source_document_id uuid NULL,
  syllabus_point_id uuid NULL,
  tags text[] NOT NULL DEFAULT '{}',
  archived boolean NOT NULL DEFAULT false,
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  paused_until timestamptz NULL,
  maintain_until date NULL,
  exclude_from_assessment boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS cards_workspace_owner_idx
  ON cards (workspace_id, owner_user_id);

CREATE TABLE IF NOT EXISTS card_review_states (
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ease double precision NOT NULL CHECK (ease >= 1.3),
  interval_days integer NOT NULL CHECK (interval_days >= 0),
  due_at timestamptz NOT NULL,
  reps integer NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses integer NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  last_grade text NULL CHECK (
    last_grade IS NULL OR last_grade IN ('again', 'hard', 'good', 'easy')
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, card_id),
  UNIQUE (workspace_id, owner_user_id, card_id)
);

CREATE INDEX IF NOT EXISTS card_review_states_workspace_due_idx
  ON card_review_states (workspace_id, owner_user_id, due_at);

CREATE OR REPLACE FUNCTION card_workspace_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_owner uuid;
BEGIN
  SELECT owner_user_id INTO workspace_owner FROM workspaces WHERE id = NEW.workspace_id;
  IF workspace_owner IS NULL THEN
    RAISE EXCEPTION 'workspace % not found', NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF workspace_owner <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'card owner must match workspace owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cards_workspace_owner_guard ON cards;
CREATE TRIGGER cards_workspace_owner_guard
  BEFORE INSERT OR UPDATE ON cards
  FOR EACH ROW
  EXECUTE FUNCTION card_workspace_owner_guard();

CREATE OR REPLACE FUNCTION card_review_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  card_workspace uuid;
  card_owner uuid;
  workspace_owner uuid;
BEGIN
  SELECT workspace_id, owner_user_id INTO card_workspace, card_owner
  FROM cards WHERE id = NEW.card_id;
  IF card_workspace IS NULL THEN
    RAISE EXCEPTION 'card % not found', NEW.card_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF card_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'review state workspace must match card workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT owner_user_id INTO workspace_owner FROM workspaces WHERE id = NEW.workspace_id;
  IF workspace_owner IS NULL OR workspace_owner <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'review state owner must match workspace owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS card_review_states_guard ON card_review_states;
CREATE TRIGGER card_review_states_guard
  BEFORE INSERT OR UPDATE ON card_review_states
  FOR EACH ROW
  EXECUTE FUNCTION card_review_state_guard();
