-- Expand the existing turn/attempt/help chain. Unknown historical identities stay NULL.
-- Roll back application code first; retain these nullable columns and receipts.
ALTER TABLE opening_turns ADD COLUMN context_anchor jsonb, ADD COLUMN composer_purpose text
  CHECK(composer_purpose IS NULL OR composer_purpose IN ('answer','explain_state','teach','plan','query'));
ALTER TABLE opening_learning_attempts ADD COLUMN context_anchor jsonb;
ALTER TABLE opening_help_exposures
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN turn_id DROP NOT NULL,
  ADD COLUMN owner_user_id uuid,
  ADD COLUMN course_id uuid,
  ADD COLUMN release_key text,
  ADD COLUMN release_intent jsonb,
  ADD COLUMN context_anchor jsonb,
  ADD COLUMN exposure_origin text,
  ADD COLUMN support_domain text NOT NULL DEFAULT 'unknown',
  ADD COLUMN generated_at timestamptz,
  ADD COLUMN released_at timestamptz,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN workspace_history_revision bigint,
  ADD CONSTRAINT opening_help_support_domain_check CHECK(support_domain IN ('language','math','unknown')),
  ADD CONSTRAINT opening_help_origin_check CHECK(exposure_origin IS NULL OR exposure_origin IN ('assistant','material_excerpt','note','card_answer','history_solution')),
  ADD CONSTRAINT opening_help_release_key_check CHECK(release_key IS NULL OR char_length(release_key) BETWEEN 8 AND 200),
  ADD CONSTRAINT opening_help_release_order_check CHECK(acknowledged_at IS NULL OR released_at IS NOT NULL);
-- The original constraint permitted only delivered rows. Generated receipts are inert until released.
ALTER TABLE opening_help_exposures DROP CONSTRAINT opening_help_exposures_delivered_check;
ALTER TABLE opening_help_exposures ADD CONSTRAINT opening_help_exposures_delivered_check
  CHECK ((release_key IS NULL AND delivered) OR (release_key IS NOT NULL AND delivered=(released_at IS NOT NULL)));
CREATE UNIQUE INDEX opening_help_release_key_uidx ON opening_help_exposures(workspace_id,release_key) WHERE release_key IS NOT NULL;
CREATE INDEX opening_help_course_item_idx ON opening_help_exposures(workspace_id,owner_user_id,course_id,problem_id) WHERE released_at IS NOT NULL;
