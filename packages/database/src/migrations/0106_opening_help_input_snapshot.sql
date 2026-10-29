-- Historical unknown inputs stay NULL; rollback retains these historical facts.
ALTER TABLE opening_turns ADD COLUMN help_input_snapshot jsonb;
ALTER TABLE opening_help_exposures ADD COLUMN help_input_snapshot jsonb;