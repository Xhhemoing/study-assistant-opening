-- Learner-visible teaching unit titles (follow-up to the worker change that titles new
-- units after the activity's intent_summary). Units compiled before that change kept the
-- internal placeholder 'Teaching draft <activity id prefix>' as their library document
-- title, which surfaces in library lists, search, notes and citations.
--
-- Data-only and idempotent: only rows whose title is still exactly the placeholder are
-- touched, so a learner rename is never overwritten and a re-run changes nothing.
-- New title = first line of the activity's intent_summary, trimmed, at most 120
-- characters; '学习讲义' when that line is blank (same rule as the worker).
--
-- Activity resolution, most specific first:
--   1. an ActivitySpec that publishes this unit, preferring the activity whose id
--      matches the placeholder suffix, then the earliest spec;
--   2. an unpublished unit (compile failed before publish): the single activity of the
--      same owner/workspace whose id starts with the placeholder suffix.
-- Units that resolve to no activity keep their title.
--
-- library_revisions is append-only and is NOT rewritten: historical revisions keep the
-- placeholder title, which also preserves the original value for rollback. updated_at is
-- left alone so the rename does not reorder recently-edited lists.

-- One statement (data-modifying CTE): both tables are renamed from the same snapshot.
WITH placeholder_units AS (
  SELECT u.id AS unit_id, u.workspace_id, u.owner_user_id, u.document_id,
    d.title AS old_title, substr(d.title, length('Teaching draft ') + 1) AS id_prefix
  FROM opening_teaching_units u
  JOIN library_documents d ON d.id = u.document_id AND d.workspace_id = u.workspace_id
  WHERE d.title ~ '^Teaching draft [0-9a-f]{8}$'
),
via_spec AS (
  SELECT DISTINCT ON (p.unit_id) p.unit_id, a.intent_summary
  FROM placeholder_units p
  JOIN opening_teaching_activity_specs s
    ON s.teaching_unit_id = p.unit_id AND s.workspace_id = p.workspace_id
  JOIN opening_teaching_activities a
    ON a.id = s.activity_id AND a.workspace_id = s.workspace_id
  ORDER BY p.unit_id, (left(a.id::text, 8) = p.id_prefix) DESC, s.created_at, s.id
),
via_prefix AS (
  SELECT p.unit_id, min(a.intent_summary) AS intent_summary
  FROM placeholder_units p
  JOIN opening_teaching_activities a
    ON a.workspace_id = p.workspace_id AND a.owner_user_id = p.owner_user_id
   AND left(a.id::text, 8) = p.id_prefix
  WHERE NOT EXISTS (SELECT 1 FROM via_spec v WHERE v.unit_id = p.unit_id)
  GROUP BY p.unit_id
  HAVING count(*) = 1
),
resolved AS (
  SELECT unit_id, intent_summary FROM via_spec
  UNION ALL
  SELECT unit_id, intent_summary FROM via_prefix
),
backfill AS (
  SELECT p.unit_id, p.document_id, p.old_title,
    COALESCE(
      NULLIF(left(regexp_replace(split_part(r.intent_summary, E'\n', 1), '^\s+|\s+$', '', 'g'), 120), ''),
      '学习讲义'
    ) AS new_title
  FROM placeholder_units p
  JOIN resolved r ON r.unit_id = p.unit_id
),
renamed_documents AS (
  UPDATE library_documents d
  SET title = b.new_title
  FROM backfill b
  WHERE d.id = b.document_id
    AND d.title = b.old_title
  RETURNING d.id
)
UPDATE opening_teaching_units u
SET title = b.new_title
FROM backfill b
WHERE u.id = b.unit_id
  AND u.title = b.old_title;

-- Rollback (manual; normally unnecessary, titles are display-only): the original
-- placeholder is still the title of each document's first library_revisions row, e.g.
--   UPDATE library_documents d SET title = r.title
--   FROM library_revisions r
--   WHERE r.document_id = d.id AND r.revision_number = 1
--     AND r.title ~ '^Teaching draft [0-9a-f]{8}$' AND d.title <> r.title;
-- (and the same for opening_teaching_units.title via document_id). Do not drop or edit
-- library_revisions to roll back.
