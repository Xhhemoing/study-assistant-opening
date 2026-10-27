ALTER TABLE course_requirements ADD COLUMN evidence_conditions jsonb;

CREATE TABLE course_requirement_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_requirement_id uuid NOT NULL,
  source_requirement_revision integer NOT NULL CHECK (source_requirement_revision > 0),
  target_requirement_id uuid NOT NULL,
  target_requirement_revision integer NOT NULL CHECK (target_requirement_revision > 0),
  stable_skill_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id),
  CONSTRAINT course_requirement_evidence_links_pair_key UNIQUE (workspace_id,source_requirement_id,target_requirement_id),
  CHECK (source_requirement_id <> target_requirement_id),
  FOREIGN KEY (workspace_id,source_requirement_id) REFERENCES course_requirements(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,target_requirement_id) REFERENCES course_requirements(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE opening_learning_asset_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('source','document')),
  asset_id uuid NOT NULL,
  asset_version integer CHECK (asset_version >= 0),
  course_id uuid,
  goal_id uuid,
  requirement_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('reference','understanding','error_reason','exploration')),
  origin_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','detached')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  client_key text NOT NULL,
  create_intent jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_learning_asset_links_client_key UNIQUE (workspace_id,owner_user_id,client_key),
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id,course_id) REFERENCES courses(workspace_id,id),
  FOREIGN KEY (workspace_id,goal_id) REFERENCES course_goals(workspace_id,id),
  FOREIGN KEY (workspace_id,requirement_id) REFERENCES course_requirements(workspace_id,id),
  CHECK ((goal_id IS NULL AND requirement_id IS NULL) OR course_id IS NOT NULL),
  CHECK (asset_type = 'source' OR asset_version IS NULL)
);
CREATE INDEX opening_learning_asset_links_asset_idx ON opening_learning_asset_links(workspace_id,owner_user_id,asset_type,asset_id,created_at,id);
CREATE INDEX opening_learning_asset_links_course_idx ON opening_learning_asset_links(workspace_id,course_id,created_at,id);
