-- Additive only: retain existing preferences.
-- Global durable prefs: NOT NULL with PM DEFAULT (balanced / hint_then_offer).
-- Course overlay: nullable jsonb partial (inherit when null).
-- No decisions table in M1 (activity checkpoint_json.interventionDecisions ring).
ALTER TABLE workspace_preferences
  ADD COLUMN intervention_settings jsonb NOT NULL DEFAULT '{"proactivity":"balanced","nodes":{"allowOnTeach":true,"allowOnPrompt":true,"allowOnLowEvidence":false},"depth":"hint_then_offer","quietMode":false}'::jsonb;

ALTER TABLE courses
  ADD COLUMN intervention_settings jsonb;
