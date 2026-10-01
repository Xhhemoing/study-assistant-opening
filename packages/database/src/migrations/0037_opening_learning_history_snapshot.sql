CREATE TABLE opening_workspace_history_revisions (
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, owner_user_id)
);

-- Zero denotes facts committed before this feature, not an inferred ordering.
ALTER TABLE opening_learning_observations
  ADD COLUMN workspace_history_revision bigint NOT NULL DEFAULT 0
    CHECK (workspace_history_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE opening_learning_observations ALTER COLUMN workspace_history_revision DROP DEFAULT;

INSERT INTO opening_workspace_history_revisions(workspace_id, owner_user_id, revision)
SELECT DISTINCT workspace_id, owner_user_id, 0 FROM opening_learning_observations;

CREATE INDEX opening_learning_observations_workspace_snapshot
  ON opening_learning_observations(workspace_id, owner_user_id, workspace_history_revision);
