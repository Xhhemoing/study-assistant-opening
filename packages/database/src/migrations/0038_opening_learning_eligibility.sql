-- Rebuildable derived eligibility; immutable learning facts remain authoritative.
CREATE TABLE opening_learning_eligibility (
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  root_observation_id uuid NOT NULL REFERENCES opening_learning_observations(id) ON DELETE CASCADE,
  head_observation_id uuid NOT NULL REFERENCES opening_learning_observations(id) ON DELETE CASCADE,
  head_revision bigint NOT NULL,
  input_revision bigint NOT NULL,
  policy_version text NOT NULL,
  help_revision bigint NOT NULL,
  item_matches boolean NOT NULL,
  source_states jsonb NOT NULL,
  privacy_source_ids text[] NOT NULL,
  independent_attempt text NOT NULL CHECK (independent_attempt IN ('yes','no','unknown')),
  verified_correct text NOT NULL CHECK (verified_correct IN ('yes','no','unknown')),
  usable_for_current_version text NOT NULL CHECK (usable_for_current_version IN ('yes','no','unknown')),
  usable_for_delayed_check text NOT NULL CHECK (usable_for_delayed_check IN ('yes','no','unknown')),
  reason_codes text[] NOT NULL,
  version_applicability text NOT NULL,
  PRIMARY KEY (workspace_id,owner_user_id,root_observation_id)
);
CREATE INDEX opening_help_exposures_attempt ON opening_help_exposures(workspace_id,attempt_id,history_revision);
CREATE INDEX opening_help_exposures_problem ON opening_help_exposures(workspace_id,problem_id,history_revision);
