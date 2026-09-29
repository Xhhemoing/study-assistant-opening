-- NULL is an AI exclusion; an array records asset deletion and outstanding object cleanup.
-- This journal outlives opening_sources and retains the existing owner/workspace boundary.
ALTER TABLE opening_privacy_exclusions
  ADD COLUMN asset_deleted_at timestamptz,
  ADD COLUMN pending_object_keys text[],
  ADD COLUMN cleanup_not_before timestamptz;

-- Transport-only lease; never replay a signed upload capability during backup restore.
ALTER TABLE opening_sources ADD COLUMN upload_url_expires_at timestamptz;
