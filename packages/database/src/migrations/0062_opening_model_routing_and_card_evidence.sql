-- M3 + E4 (model gateway & evidence loop plan). Additive: new columns are defaulted or
-- nullable and the relaxed checks accept every existing row.

-- M3: workspace models may take audio input and may run on a provider free tier.
-- A free-tier model has no per-token price; it is bounded by a per-day request cap instead.
ALTER TABLE opening_model_provider_models
  ADD COLUMN IF NOT EXISTS supports_audio boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing text NOT NULL DEFAULT 'metered'
    CHECK (billing IN ('metered', 'free_tier')),
  ADD COLUMN IF NOT EXISTS daily_request_cap integer NULL
    CHECK (daily_request_cap IS NULL OR daily_request_cap BETWEEN 1 AND 100000);

ALTER TABLE opening_model_provider_models
  DROP CONSTRAINT IF EXISTS opening_model_provider_models_input_cents_per_million_check,
  DROP CONSTRAINT IF EXISTS opening_model_provider_models_output_cents_per_million_check,
  ADD CONSTRAINT opening_model_provider_models_pricing_check CHECK (
    (billing = 'metered' AND input_cents_per_million > 0 AND output_cents_per_million > 0)
    OR (billing = 'free_tier' AND input_cents_per_million >= 0 AND output_cents_per_million >= 0
        AND daily_request_cap IS NOT NULL)
  );

-- M3: free-tier calls still go through the ledger (idempotency, model snapshot, replay)
-- at zero cost. The repository only accepts a zero amount together with a request cap.
ALTER TABLE opening_budget_reservations
  DROP CONSTRAINT IF EXISTS opening_budget_reservations_amount_cents_check,
  ADD CONSTRAINT opening_budget_reservations_amount_cents_check CHECK (amount_cents >= 0),
  DROP CONSTRAINT IF EXISTS opening_budget_reservations_reserved_amount_cents_check,
  ADD CONSTRAINT opening_budget_reservations_reserved_amount_cents_check
    CHECK (reserved_amount_cents IS NULL OR reserved_amount_cents >= 0);

-- E4: a card linked to a course and skill writes its reviews into the learning ledger.
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS course_id uuid NULL REFERENCES courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS skill_label text NULL
    CHECK (skill_label IS NULL OR char_length(skill_label) BETWEEN 1 AND 200);

-- Rollback (delete or reprice free-tier models and zero-cost reservations first):
-- DELETE FROM opening_model_provider_models WHERE billing = 'free_tier';
-- ALTER TABLE opening_model_provider_models DROP CONSTRAINT opening_model_provider_models_pricing_check,
--   ADD CONSTRAINT opening_model_provider_models_input_cents_per_million_check CHECK (input_cents_per_million > 0),
--   ADD CONSTRAINT opening_model_provider_models_output_cents_per_million_check CHECK (output_cents_per_million > 0),
--   DROP COLUMN daily_request_cap, DROP COLUMN billing, DROP COLUMN supports_audio;
-- UPDATE opening_budget_reservations SET amount_cents = 1 WHERE amount_cents = 0;
-- UPDATE opening_budget_reservations SET reserved_amount_cents = 1 WHERE reserved_amount_cents = 0;
-- ALTER TABLE opening_budget_reservations
--   DROP CONSTRAINT opening_budget_reservations_amount_cents_check,
--   ADD CONSTRAINT opening_budget_reservations_amount_cents_check CHECK (amount_cents > 0),
--   DROP CONSTRAINT opening_budget_reservations_reserved_amount_cents_check,
--   ADD CONSTRAINT opening_budget_reservations_reserved_amount_cents_check CHECK (reserved_amount_cents IS NULL OR reserved_amount_cents > 0);
-- ALTER TABLE cards DROP COLUMN course_id, DROP COLUMN skill_label;
