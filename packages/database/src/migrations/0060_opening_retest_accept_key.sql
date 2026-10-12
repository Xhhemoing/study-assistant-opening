-- PR-E (PM sign-off required): unique protection for the retest accept clientKey.
-- Key = COALESCE(payload->>'acceptClientKey', result->>'clientKey'): the current writer's
-- spelling plus the legacy JSON-only writer's result.clientKey. Scope = workspace + owner.
-- Lock: plain (non-CONCURRENTLY) build takes SHARE on opening_jobs (reads continue, job
-- writes wait for the build). lock_timeout makes the migration fail fast instead of
-- queueing behind a long transaction and stalling every job writer.
-- Duplicates are never deleted: the guard below fails with the conflicting job ids.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  groups integer;
  sample text;
BEGIN
  WITH dup AS (
    SELECT workspace_id, owner_user_id, array_agg(id ORDER BY created_at, id) AS job_ids
    FROM opening_jobs
    WHERE kind = 'retest' AND COALESCE(payload->>'acceptClientKey', result->>'clientKey') IS NOT NULL
    GROUP BY workspace_id, owner_user_id, COALESCE(payload->>'acceptClientKey', result->>'clientKey')
    HAVING count(*) > 1
  )
  SELECT (SELECT count(*) FROM dup),
         (SELECT string_agg(format('workspace=%s owner=%s jobs=%s', workspace_id, owner_user_id, job_ids), '; ')
            FROM (SELECT * FROM dup ORDER BY workspace_id, owner_user_id LIMIT 20) s)
    INTO groups, sample;
  IF groups > 0 THEN
    RAISE EXCEPTION 'PR-E 0060 blocked: % duplicate retest accept clientKey group(s); resolve manually (no auto-delete)', groups
      USING DETAIL = sample,
            HINT = 'Inspect the listed jobs (same key, different candidates), resolve with PM sign-off, then re-run migrations.';
  END IF;
END $$;

CREATE UNIQUE INDEX opening_jobs_retest_accept_key_uidx
  ON opening_jobs (workspace_id, owner_user_id, (COALESCE(payload->>'acceptClientKey', result->>'clientKey')))
  WHERE kind = 'retest' AND COALESCE(payload->>'acceptClientKey', result->>'clientKey') IS NOT NULL;

-- Rollback: DROP INDEX opening_jobs_retest_accept_key_uidx;
