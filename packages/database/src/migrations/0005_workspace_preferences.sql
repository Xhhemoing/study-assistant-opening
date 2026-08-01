-- 0005_workspace_preferences.sql
-- One server-authoritative default application entry per workspace.

CREATE TABLE workspace_preferences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  default_entry text NOT NULL CHECK (default_entry IN ('learn', 'explore', 'library')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
