CREATE TABLE promotion_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 exploration_id uuid NOT NULL REFERENCES explorations(id) ON DELETE CASCADE, source_turn_id uuid NULL,
 kind text NOT NULL CHECK(kind IN ('note','card','question','task')), title text NOT NULL CHECK(char_length(trim(title)) BETWEEN 1 AND 200), body text NOT NULL CHECK(char_length(trim(body)) BETWEEN 1 AND 20000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')), target_type text NULL CHECK(target_type IN ('document','card','question','task')), target_id uuid NULL, reviewed_at timestamptz NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(target_type,target_id),
 FOREIGN KEY(workspace_id,exploration_id) REFERENCES explorations(workspace_id,id) ON DELETE CASCADE,
 CHECK((status='pending' AND reviewed_at IS NULL AND target_type IS NULL AND target_id IS NULL) OR (status='rejected' AND reviewed_at IS NOT NULL AND target_type IS NULL AND target_id IS NULL) OR (status='accepted' AND reviewed_at IS NOT NULL AND target_type IS NOT NULL AND target_id IS NOT NULL))
);
CREATE INDEX promotion_records_workspace_exploration_idx ON promotion_records(workspace_id,exploration_id,created_at);
CREATE TABLE promotion_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 promotion_id uuid NOT NULL UNIQUE, exploration_id uuid NOT NULL, source_turn_id uuid NULL, kind text NOT NULL CHECK(kind IN ('card','question','task')), title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,promotion_id) REFERENCES promotion_records(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,exploration_id) REFERENCES explorations(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX promotion_targets_workspace_idx ON promotion_targets(workspace_id,created_at);
