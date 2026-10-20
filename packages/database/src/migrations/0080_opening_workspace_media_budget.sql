-- Optional, user-supplied provider/model billing limits. Never infer token bounds from media bytes.
-- Roll back application code first and retain these nullable columns and existing values.
ALTER TABLE opening_model_provider_models
  ADD COLUMN media_input_token_upper_bound bigint,
  ADD COLUMN media_max_input_bytes integer,
  ADD COLUMN media_input_cents_per_million double precision,
  ADD CONSTRAINT opening_workspace_media_budget_check CHECK (
    (media_input_token_upper_bound IS NULL AND media_max_input_bytes IS NULL AND media_input_cents_per_million IS NULL)
    OR (media_input_token_upper_bound IS NOT NULL AND media_max_input_bytes IS NOT NULL AND media_input_cents_per_million IS NOT NULL
      AND media_input_token_upper_bound BETWEEN 1 AND 9007199254740991
      AND media_max_input_bytes BETWEEN 1 AND 104857600
      AND media_input_cents_per_million >= 0 AND media_input_cents_per_million < 'Infinity'::double precision
      AND (billing = 'free_tier' OR media_input_cents_per_million > 0))
  );
COMMENT ON COLUMN opening_model_provider_models.media_input_token_upper_bound IS
  'User-verified bound from supplier context limits, covering all media admitted by media_max_input_bytes; not inferred from encoded bytes.';
COMMENT ON COLUMN opening_model_provider_models.media_input_cents_per_million IS
  'Conservative rate for the entire prompt (text and media); usage-based estimates remain identifiable for receipt reconciliation.';
