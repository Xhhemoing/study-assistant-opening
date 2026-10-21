-- Preserve existing schedules; replay review history only at the next real review.
ALTER TABLE card_review_states ADD COLUMN srs_version text NOT NULL DEFAULT 'srs-1';
ALTER TABLE card_review_states ADD COLUMN fsrs_state jsonb;
ALTER TABLE card_review_states ADD CONSTRAINT card_review_states_fsrs_version_check
  CHECK ((srs_version='srs-1' AND fsrs_state IS NULL)
    OR (srs_version='fsrs-5.4.2' AND fsrs_state IS NOT NULL AND jsonb_typeof(fsrs_state)='object'));
-- The observation root remains a historical origin, including after a correction/retraction.
-- No FK: Opening restores cards before observations; validate the scoped origin in its backup validator.
ALTER TABLE cards ADD COLUMN origin_observation_root_id uuid;
ALTER TABLE cards ADD COLUMN auto_paused boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX cards_auto_observation_uidx ON cards(workspace_id,owner_user_id,origin_observation_root_id);
