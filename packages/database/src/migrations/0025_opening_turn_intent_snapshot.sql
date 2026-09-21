-- 0025_opening_turn_intent_snapshot.sql
-- Saved tutor intent idempotency and server-owned material version snapshots.

ALTER TABLE opening_turns
  ADD COLUMN IF NOT EXISTS intent_hash text,
  ADD COLUMN IF NOT EXISTS source_versions jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION opening_source_versions_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry record;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT * FROM jsonb_each(value) LOOP
    IF entry.key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      OR jsonb_typeof(entry.value) <> 'number'
      OR (entry.value #>> '{}') !~ '^[0-9]+$'
    THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE opening_turns
  DROP CONSTRAINT IF EXISTS opening_turns_source_versions_object_check;

ALTER TABLE opening_turns
  ADD CONSTRAINT opening_turns_source_versions_object_check
  CHECK (opening_source_versions_valid(source_versions));
