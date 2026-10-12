-- 0058_opening_turn_clarify.sql
-- LAB-U01: a page-citation refusal ends its assistant turn as 'clarify'
-- (a terminal Clarify follow-up), never as 'failed'. Same pattern as 0026;
-- opening_turns only. The tutor job keeps status 'failed' with
-- error {code:'page_not_in_sources', nextAction:'clarify'}.
-- Ported from WIP 05ffeec (originally numbered 0046); renumbered to 0058, the next
-- free number at tip 07862cf. Appends 'clarify' to the current 0026 values only.

ALTER TABLE opening_turns
  DROP CONSTRAINT IF EXISTS opening_turns_status_check;

ALTER TABLE opening_turns
  ADD CONSTRAINT opening_turns_status_check
  CHECK (status IN ('pending', 'complete', 'failed', 'clarify', 'outcome_unknown'));

-- Rollback (only after no row uses 'clarify'):
-- ALTER TABLE opening_turns DROP CONSTRAINT IF EXISTS opening_turns_status_check;
-- ALTER TABLE opening_turns ADD CONSTRAINT opening_turns_status_check
--   CHECK (status IN ('pending', 'complete', 'failed', 'outcome_unknown'));
