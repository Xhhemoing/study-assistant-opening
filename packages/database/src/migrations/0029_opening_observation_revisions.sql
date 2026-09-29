ALTER TABLE opening_learning_observations
  ADD COLUMN root_observation_id uuid REFERENCES opening_learning_observations(id),
  ADD COLUMN revises_observation_id uuid REFERENCES opening_learning_observations(id),
  ADD COLUMN revision_kind text DEFAULT 'original' CHECK (revision_kind IN ('original','replace','retract')),
  ADD COLUMN revision_reason text,
  ADD COLUMN actor_id uuid,
  ADD COLUMN effective_head_id uuid REFERENCES opening_learning_observations(id);
-- Nullable metadata preserves import of old archives. Readers treat NULL root/head as the row itself.
UPDATE opening_learning_observations SET root_observation_id=id,effective_head_id=id,actor_id=owner_user_id;
CREATE INDEX opening_learning_observations_root ON opening_learning_observations(workspace_id,owner_user_id,root_observation_id);
CREATE UNIQUE INDEX opening_learning_observations_successor ON opening_learning_observations(revises_observation_id) WHERE revises_observation_id IS NOT NULL;
