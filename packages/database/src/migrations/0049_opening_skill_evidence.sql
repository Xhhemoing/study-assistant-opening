-- K02: SkillEvidence projection linking learning observations to knowledge nodes.
-- LearningEvent / observation history remains authoritative; rollback drops this table only.
CREATE TABLE opening_skill_evidence (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  node_id UUID NOT NULL,
  observation_id UUID NOT NULL REFERENCES opening_learning_observations(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('recall', 'explain', 'procedure', 'transfer', 'timed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, observation_id, node_id, dimension)
);

CREATE INDEX opening_skill_evidence_node_idx
  ON opening_skill_evidence (workspace_id, owner_user_id, node_id, created_at, id);

CREATE INDEX opening_skill_evidence_observation_idx
  ON opening_skill_evidence (workspace_id, owner_user_id, observation_id);

CREATE INDEX opening_skill_evidence_course_idx
  ON opening_skill_evidence (workspace_id, owner_user_id, course_id);

-- Rollback:
-- DROP TABLE opening_skill_evidence;
