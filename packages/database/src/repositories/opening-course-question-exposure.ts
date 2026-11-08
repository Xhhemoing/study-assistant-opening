import { randomUUID } from "node:crypto";
import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { reservedArithmeticIdentity, type OpeningReservedExposureInput, type OpeningReservedExposureResult } from "./opening-course-reserved-selection";

type Db = Sql | TransactionSql;
const protocol = "course-question-exposure-1";
export type CourseQuestionExposureInput = {
  surfaceKey: string; kind: "teaching" | "example" | "hint" | "presented";
  text?: string; body?: unknown; identityRefId?: string; itemVersionId?: string; sourceVersions: Record<string, number>;
};
/** Exact arithmetic only: unsupported conditions/figures must never silently disappear. */
export function extractCourseQuestionExposure(body: unknown) {
  const expressions = new Set<string>(), families = new Set<string>();
  let complete = true;
  function visit(value: unknown) {
    if (typeof value === "string") {
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return;
      const whole = reservedArithmeticIdentity(value);
      if (whole) { expressions.add(whole.expression); families.add(whole.familyId); return; }
      // Fragment matching cannot resolve parenthesized, LaTeX or multi-step
      // conditions embedded in prose. Do not claim the partial parse is complete.
      if (/\d/.test(value) && /[(){}]|\\frac|=/.test(value)) complete = false;
      const fragments = value.match(/[-+]?\d+(?:\.\d+)?(?:\s*(?:[+*/×÷−-]|\\times|\\div)\s*[-+]?\d+(?:\.\d+)?)+/g) ?? [];
      for (const fragment of fragments) {
        const exact = reservedArithmeticIdentity(fragment);
        if (!exact) complete = false;
        else { expressions.add(exact.expression); families.add(exact.familyId); }
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
      if (/image|figure|vector|drawing|photo|attachment/i.test(key) && entry != null && entry !== ""
        && !(Array.isArray(entry) && !entry.length)) complete = false;
      if (key === "status" && ["outcome_unknown", "pending", "streaming"].includes(String(entry))) complete = false;
      visit(entry);
    }
  }
  visit(body);
  return { complete, expressions: [...expressions].sort(), families: [...families].sort() };
}

/** Caller owns the history transaction. Store exact descriptors only, never keys or raw model output. */
export async function recordCourseQuestionExposure(tx: TransactionSql, scope: Scope, input: CourseQuestionExposureInput): Promise<void> {
  await lockWorkspaceLearningHistory(tx, scope);
  const [history] = await tx`SELECT revision FROM opening_workspace_history_revisions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const exact = extractCourseQuestionExposure(input.body ?? input.text);
  await tx`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,identity_ref_id,
    exact_content,source_versions,item_version_id,history_revision)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.surfaceKey},${input.kind},${input.identityRefId ?? null},
      ${exact.complete ? tx.json(exact) : null},${tx.json(input.sourceVersions)},${input.itemVersionId ?? null},${history!.revision})
    ON CONFLICT(workspace_id,owner_user_id,surface_key) DO NOTHING`;
}

/**
 * Rescan all durable server-visible textual surfaces, including old source versions
 * and unpublished/answered/unanswered prompts. This deliberately overcounts public
 * persistence as exposure; it never promotes absence of an attempt into unseen.
 * Only a DB-created genesis plus sticky deletion-gap tracking can support coverage.
 * No caller may provide complete=true or a watermark.
 */
export async function refreshCourseQuestionExposure(tx: TransactionSql, scope: Scope): Promise<boolean> {
  await lockWorkspaceLearningHistory(tx, scope);
  const [origin] = await tx`SELECT to_jsonb(c)->>'genesis_verified' AS genesis_verified,
    to_jsonb(c)->>'invalidated' AS invalidated FROM opening_course_question_exposure_coverage c
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND protocol=${protocol} FOR UPDATE`;
  // The current storage-only migration has neither proof. Absent fields/rows
  // fail closed until the schema owner supplies the approved genesis protocol.
  if (origin?.genesis_verified !== "true" || origin.invalidated !== "false") return false;
  const rows = await tx`SELECT 'revision:'||r.id::text AS surface,r.blocks AS body FROM library_revisions r WHERE r.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'block:'||b.id::text,b.content FROM library_blocks b WHERE b.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'item:'||v.id::text,jsonb_build_object('stem',v.stem_snapshot) FROM opening_learning_item_versions v
      WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
    UNION ALL SELECT 'turn:'||t.id::text,jsonb_build_object('text',t.text,'status',t.status,'snapshot',t.help_input_snapshot) FROM opening_turns t
      JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
      WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
    UNION ALL SELECT 'source:'||c.id::text,jsonb_build_object('text',c.text,'image',c.image_object_key) FROM opening_source_chunks c
      JOIN opening_sources s ON s.id=c.source_id WHERE s.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'help:'||h.id::text,to_jsonb(h) FROM opening_help_exposures h WHERE h.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'card:'||c.id::text,to_jsonb(c) FROM cards c WHERE c.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'observation:'||o.id::text,jsonb_build_object('answer',o.answer) FROM opening_learning_observations o
      WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
    UNION ALL SELECT 'checkpoint:'||a.id::text,a.checkpoint_json FROM opening_teaching_activities a
      WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  const [gaps] = await tx`SELECT (
    EXISTS(SELECT 1 FROM opening_privacy_exclusions WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM opening_source_versions WHERE workspace_id=${scope.workspaceId} AND availability<>'available')
    OR EXISTS(SELECT 1 FROM opening_sources s WHERE s.workspace_id=${scope.workspaceId} AND
      (s.upload_state<>'uploaded' OR s.parse_state<>'ready' OR s.mime<>'text/plain'
       OR NOT EXISTS(SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version)))
    OR EXISTS(SELECT 1 FROM opening_exam_sprints WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM opening_measurement_trials WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM practice_sessions WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM explorations WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM opening_memories WHERE workspace_id=${scope.workspaceId})
    OR EXISTS(SELECT 1 FROM opening_learning_attempts a LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id
      WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND (v.id IS NULL OR v.stem_snapshot IS NULL))
    ) AS unknown`;
  let complete = gaps?.unknown === false;
  const [history] = await tx`SELECT revision FROM opening_workspace_history_revisions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  for (const row of rows) {
    const exact = extractCourseQuestionExposure(row.body);
    if (!exact.complete) complete = false;
    // Immutable facts: retain every older descriptor. No hash/UPDATE needed;
    // equality against the actual persisted descriptor determines replay.
    const previous = await tx`SELECT id FROM opening_course_question_exposures
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND surface_key LIKE ${String(row.surface) + ":%"} AND exact_content=${tx.json(exact)}::jsonb LIMIT 1`;
    if (!previous.length) await tx`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
      VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${String(row.surface) + ":" + randomUUID()},'teaching',${tx.json(exact)},'{}',${history!.revision})`;
  }
  const unknown = await tx`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND (exact_content IS NULL OR exact_content->>'complete'<>'true') LIMIT 1`;
  if (unknown.length) complete = false;
  await tx`UPDATE opening_course_question_exposure_coverage SET complete=${complete},history_revision=${history!.revision},covered_surface_count=${rows.length}
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND to_jsonb(opening_course_question_exposure_coverage)->>'invalidated'='false'`;
  return complete;
}

/** Consumer adapter. Reads are transactional: scanner, watermark and selection share the history lock. */
export async function readCourseQuestionExposure(db: Db, scope: Scope, input: OpeningReservedExposureInput): Promise<OpeningReservedExposureResult> {
  if ("begin" in db) return (db as Sql).begin(tx => readCourseQuestionExposure(tx, scope, input));
  const tx = db as TransactionSql;
  const complete = await refreshCourseQuestionExposure(tx, scope);
  const exact = reservedArithmeticIdentity(input.text);
  const [coverage] = await tx`SELECT c.complete,to_jsonb(c)->>'invalidated' AS invalidated,c.history_revision,h.revision FROM opening_course_question_exposure_coverage c
    JOIN opening_workspace_history_revisions h ON h.workspace_id=c.workspace_id AND h.owner_user_id=c.owner_user_id
    WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND c.protocol=${protocol}`;
  if (!complete || !exact || !coverage?.complete || coverage.invalidated !== "false" || String(coverage.history_revision) !== String(coverage.revision))
    return { coverage: "unknown", exactExposed: false, familyExposed: false, reason: "曝光历史无可信起点、存在缺口或版本不完整" };
  const rows = await tx`SELECT exact_content FROM opening_course_question_exposures WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return { coverage: "complete", exactExposed: rows.some(row => (row.exact_content as { expressions: string[] }).expressions.includes(exact.expression)),
    familyExposed: rows.some(row => (row.exact_content as { families: string[] }).families.includes(exact.familyId)), reason: null };
}
