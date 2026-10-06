-- Opening strategy template provenance on saved tutor turns.
-- Additive only; existing turns resolve to the default strategy at runtime.
ALTER TABLE opening_turns
  ADD COLUMN strategy_template_id TEXT;

-- Rollback: ALTER TABLE opening_turns DROP COLUMN strategy_template_id;
