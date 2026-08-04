-- Workspace-scoped persisted free explorations, branches, and append-oriented blocks.

CREATE TABLE explorations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  course_id uuid NULL REFERENCES courses (id) ON DELETE SET NULL,
  goal_id uuid NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT explorations_closed_at_check CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR (status = 'open' AND closed_at IS NULL)),
  CONSTRAINT explorations_workspace_id_id_uidx UNIQUE (workspace_id, id)
);

CREATE INDEX explorations_workspace_updated_idx
  ON explorations (workspace_id, updated_at DESC);
CREATE INDEX explorations_workspace_owner_idx
  ON explorations (workspace_id, owner_user_id);

CREATE TABLE exploration_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  exploration_id uuid NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
  parent_branch_id uuid NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exploration_branches_workspace_id_id_uidx UNIQUE (workspace_id, id),
  CONSTRAINT exploration_branches_workspace_exploration_id_uidx UNIQUE (workspace_id, exploration_id, id),
  CONSTRAINT exploration_branches_exploration_workspace_fk
    FOREIGN KEY (workspace_id, exploration_id)
    REFERENCES explorations (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT exploration_branches_parent_fk
    FOREIGN KEY (workspace_id, exploration_id, parent_branch_id)
    REFERENCES exploration_branches (workspace_id, exploration_id, id) ON DELETE CASCADE
);

CREATE INDEX exploration_branches_workspace_exploration_idx
  ON exploration_branches (workspace_id, exploration_id, created_at);
CREATE INDEX exploration_branches_parent_idx
  ON exploration_branches (workspace_id, parent_branch_id);

CREATE TABLE exploration_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  exploration_id uuid NOT NULL REFERENCES explorations (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scratch', 'hypothesis', 'open_question')),
  content text NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 20000),
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exploration_blocks_branch_position_uidx UNIQUE (branch_id, position),
  CONSTRAINT exploration_blocks_exploration_workspace_fk
    FOREIGN KEY (workspace_id, exploration_id)
    REFERENCES explorations (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT exploration_blocks_branch_workspace_fk
    FOREIGN KEY (workspace_id, exploration_id, branch_id)
    REFERENCES exploration_branches (workspace_id, exploration_id, id) ON DELETE CASCADE
);

CREATE INDEX exploration_blocks_workspace_exploration_position_idx
  ON exploration_blocks (workspace_id, exploration_id, branch_id, position);

CREATE OR REPLACE FUNCTION touch_exploration_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER explorations_updated_at_trigger
  BEFORE UPDATE ON explorations
  FOR EACH ROW EXECUTE FUNCTION touch_exploration_updated_at();
CREATE TRIGGER exploration_branches_updated_at_trigger
  BEFORE UPDATE ON exploration_branches
  FOR EACH ROW EXECUTE FUNCTION touch_exploration_updated_at();
CREATE TRIGGER exploration_blocks_updated_at_trigger
  BEFORE UPDATE ON exploration_blocks
  FOR EACH ROW EXECUTE FUNCTION touch_exploration_updated_at();
