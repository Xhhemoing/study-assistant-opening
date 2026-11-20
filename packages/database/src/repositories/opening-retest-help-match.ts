import type { Sql, TransactionSql } from "postgres";

export function openingRetestAnswerAt(db: Sql | TransactionSql) {
  return db`COALESCE(a.submitted_at,o.submitted_at,o.recorded_at,o.occurred_at)`;
}

function openingHelpReferenceSources(db: Sql | TransactionSql) {
  const reference = db`h.release_intent->'originReference'`;
  const sources = db`CASE WHEN jsonb_typeof(${reference}->'sourceRefs')='array'
    THEN ${reference}->'sourceRefs' ELSE '[]'::jsonb END`;
  const matches = db`EXISTS (SELECT 1 FROM jsonb_array_elements(${sources}) ref
    WHERE lower(ref->>'sourceId')=ANY(o.source_ids::text[]))`;
  return { reference, sources, matches };
}

/** Scope shared by the interval matcher and legacy evidence projection. Callers bind h, l and o. */
export function openingHelpCourseAndDomainMatches(db: Sql | TransactionSql) {
  return db`(h.course_id IS NULL OR h.course_id=o.course_id)
    AND (l.course_id IS NULL OR l.course_id=o.course_id)
    AND (h.support_domain IS DISTINCT FROM 'language' OR o.requirement_key LIKE 'language:%')`;
}

export function openingUnboundHelpScopeMatches(db: Sql | TransactionSql) {
  const { reference, sources, matches } = openingHelpReferenceSources(db);
  return db`COALESCE(h.release_intent->>'possibleOpenAttemptOnly','')<>'true'
    AND COALESCE(${reference}->>'possibleOpenAttemptOnly','')<>'true'
    AND (h.context_anchor->>'sourceId' IS NULL OR lower(h.context_anchor->>'sourceId')=ANY(o.source_ids::text[]))
    AND (jsonb_array_length(${sources})=0 OR ${matches})
    AND (${reference}->>'skillLabel' IS NULL OR ${reference}->>'skillLabel'=o.skill_label)
    AND (${reference}->>'requirementKey' IS NULL OR ${reference}->>'requirementKey'=o.requirement_key)`;
}

/** Shared by course-route outcomes and delayed evidence. Callers bind o, a, baseline, r, h and l. */
export function openingRetestHelpMatches(db: Sql | TransactionSql) {
  const requirement = db`r.learning_protocol->>'requirementId'`;
  const { reference, matches } = openingHelpReferenceSources(db);
  return db`
    h.workspace_id=o.workspace_id
    AND COALESCE(h.owner_user_id,l.owner_user_id)=o.owner_user_id
    AND ${openingHelpCourseAndDomainMatches(db)}
    AND h.delivered=TRUE AND h.kind IS DISTINCT FROM 'instruction'
    AND COALESCE(h.released_at,h.delivered_at,h.created_at)>baseline.recorded_at
    AND COALESCE(h.released_at,h.delivered_at,h.created_at)<=${openingRetestAnswerAt(db)}
    AND (
      h.attempt_id=o.attempt_id OR (
        h.attempt_id IS NULL
        AND ${openingUnboundHelpScopeMatches(db)}
        AND (
          h.item_version_id=a.item_version_id OR h.problem_id=a.problem_id
          OR h.activity_id=a.activity_id OR h.session_id=o.session_id
          OR lower(h.context_anchor->>'sourceId')=ANY(o.source_ids::text[])
          OR ${matches}
          OR ${reference}->>'skillLabel'=o.skill_label
          OR (l.course_id=o.course_id AND l.skill_label=o.skill_label)
          OR EXISTS (SELECT 1 FROM opening_teaching_activities activity
            WHERE activity.workspace_id=o.workspace_id AND activity.owner_user_id=o.owner_user_id
              AND activity.course_id=o.course_id AND activity.id IN (h.activity_id,l.activity_id)
              AND activity.goal_json->'courseRoute'->>'requirementId'=${requirement})
          OR EXISTS (SELECT 1 FROM opening_learning_attempts bound
            WHERE bound.workspace_id=o.workspace_id AND bound.owner_user_id=o.owner_user_id
              AND bound.course_id=o.course_id AND bound.requirement_key=o.requirement_key
              AND (bound.item_version_id=h.item_version_id OR bound.problem_id=h.problem_id))
          OR EXISTS (SELECT 1 FROM opening_learning_item_versions item
            LEFT JOIN opening_teaching_activities activity ON activity.id=item.activity_id
              AND activity.workspace_id=item.workspace_id AND activity.owner_user_id=item.owner_user_id
              AND activity.course_id=item.course_id
            WHERE item.workspace_id=o.workspace_id AND item.owner_user_id=o.owner_user_id
              AND item.course_id=o.course_id AND (item.id=h.item_version_id OR item.problem_id=h.problem_id)
              AND (item.evaluation_spec->'courseRequirement'->>'id'=${requirement}
                OR item.evaluation_spec->>'requirementKey'=o.requirement_key
                OR activity.goal_json->'courseRoute'->>'requirementId'=${requirement}
                OR EXISTS (SELECT 1 FROM opening_course_reserved_questions reserved
                  WHERE reserved.workspace_id=item.workspace_id AND reserved.owner_user_id=item.owner_user_id
                    AND reserved.course_id=item.course_id AND reserved.issued_item_version_id=item.id
                    AND reserved.requirement_id::text=${requirement})))
        )
      )
    )`;
}
