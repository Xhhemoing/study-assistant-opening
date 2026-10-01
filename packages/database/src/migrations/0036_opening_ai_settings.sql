-- Additive only: retain existing preferences and budget reservations.
ALTER TABLE workspace_preferences ADD COLUMN ai_settings jsonb;
ALTER TABLE opening_budget_reservations ADD COLUMN model_snapshot jsonb;
