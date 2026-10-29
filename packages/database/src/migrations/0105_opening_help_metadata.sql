-- Only trusted delivery boundaries record these facts. Never backfill old releases.
ALTER TABLE opening_help_exposures
  ADD COLUMN hint_stage integer CHECK (hint_stage BETWEEN 1 AND 4),
  ADD COLUMN initiated_by text CHECK (initiated_by IN ('user', 'assistant'));
