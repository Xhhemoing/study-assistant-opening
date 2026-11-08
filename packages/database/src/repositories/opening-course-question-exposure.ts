import { randomUUID } from "node:crypto";
import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import type { OpeningReservedExposureInput, OpeningReservedExposureResult } from "./opening-course-reserved-selection";
import { reservedArithmeticIdentity, reservedArithmeticExposureText } from "./opening-reserved-arithmetic-identity";

type Db = Sql | TransactionSql;
const protocol = "course-question-exposure-1";
const grammar = "reserved-arithmetic-2";
const descriptorSchema = z.object({ grammar: z.literal(grammar), complete: z.literal(true), expressions: z.array(z.string()), families: z.array(z.string()) }).strict();
export type CourseQuestionExposureInput = {
  surfaceKey: string; kind: "teaching" | "example" | "hint" | "presented";
  text?: string; body?: unknown; identityRefId?: string; itemVersionId?: string; sourceVersions: Record<string, number>;
};
/** Exact arithmetic only: unsupported conditions/figures must never silently disappear. */
export function extractCourseQuestionExposure(body: unknown) {
  const expressions = new Set<string>(), families = new Set<string>();
  let complete = body != null;
  function visit(value: unknown) {
    if (typeof value === "string") {
      const parsed = reservedArithmeticExposureText(value);
      if (!parsed.complete) complete = false;
      if (parsed.identity) { expressions.add(parsed.identity.expression); families.add(parsed.identity.familyId); }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
      if (/image|figure|vector|drawing|photo|attachment/i.test(key) && entry != null && entry !== ""
        && !(Array.isArray(entry) && !entry.length)) complete = false;
      if (key === "status" && ["outcome_unknown", "pending", "streaming"].includes(String(entry))) complete = false;
      visit(entry);
    }
  }
  visit(body);
  return { grammar, complete, expressions: [...expressions].sort(), families: [...families].sort() };
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
  const [stored] = await tx`SELECT kind,identity_ref_id,exact_content,source_versions,item_version_id
    FROM opening_course_question_exposures WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND surface_key=${input.surfaceKey}`;
  if (!stored || stored.kind !== input.kind || stored.identity_ref_id !== (input.identityRefId ?? null)
    || stored.item_version_id !== (input.itemVersionId ?? null) || !isDeepStrictEqual(stored.source_versions, input.sourceVersions)
    || !isDeepStrictEqual(stored.exact_content, exact.complete ? exact : null)) {
    throw learningError("CONFLICT", "曝光重放内容与原始记录不同。");
  }
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
  // Narrow rollout: the legacy surface writers do not all share the history
  // lock. Fail-fast table locks fence their INSERT/UPDATE/DELETE until selection
  // and issuance commit. NOWAIT avoids reversing a writer's business->history
  // lock order. Never retry here or promote a contended scan into unseen.
  // SHARE ROW EXCLUSIVE also serializes lock upgrades when issuance writes a
  // library revision in this same transaction.
  await tx`LOCK TABLE library_revisions,library_blocks,opening_sources,opening_source_chunks,
    opening_learning_item_versions,opening_problem_refs,opening_turns,opening_conversations,
    opening_help_exposures,cards,opening_learning_observations,opening_teaching_activities,
    opening_privacy_exclusions,opening_source_versions,opening_exam_sprints,opening_measurement_trials,
    practice_sessions,explorations,opening_memories IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
  const [origin] = await tx`SELECT invalidated FROM opening_course_question_exposure_coverage c
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND protocol=${protocol} FOR UPDATE`;
  // 0109's guard only permits INSERT from the workspace genesis trigger.
  // No row means pre-migration/unknown history, even when all current tables empty.
  if (!origin || origin.invalidated !== false) return false;
  // The first 0109 handoff omitted sticky protection on these mutable surfaces.
  // Presence of a genesis row cannot recover text removed BEFORE our first scan.
  // Inspect the actual DB triggers (not a caller/version flag) until the schema
  // owner's follow-up lands. Each must use the sticky invalidator for DELETE and
  // the named content UPDATE; table fences alone only protect concurrent writes.
  const [protection] = await tx`SELECT NOT EXISTS (
    SELECT 1 FROM (VALUES ('library_blocks','content'),('opening_problem_refs','stem_snapshot'),
      ('opening_teaching_activities','checkpoint_json'),('opening_learning_observations','answer'),
      ('opening_course_question_exposures',NULL)) AS required(table_name,column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=current_schema() AND c.relname=required.table_name AND NOT t.tgisinternal AND t.tgenabled='O'
        AND p.proname='opening_course_question_history_invalidate' AND (t.tgtype::int & 11)=11
        AND (required.column_name IS NULL OR (t.tgtype::int & 16)=16 AND
          (t.tgattr=''::int2vector OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
            AND a.attname=required.column_name AND a.attnum=ANY(t.tgattr)))))
    ) AS complete`;
  if (protection?.complete !== true) return false;
  const rows = await tx`SELECT 'revision:'||r.id::text AS surface,r.blocks AS body FROM library_revisions r WHERE r.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'block:'||b.id::text,b.content FROM library_blocks b WHERE b.workspace_id=${scope.workspaceId}
    UNION ALL SELECT 'item:'||v.id::text,jsonb_build_object('stem',v.stem_snapshot) FROM opening_learning_item_versions v
      WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
    UNION ALL SELECT 'problem:'||p.problem_id::text,jsonb_build_object('stem',p.stem_snapshot) FROM opening_problem_refs p
      WHERE p.workspace_id=${scope.workspaceId}
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
    OR EXISTS(SELECT 1 FROM opening_problem_refs p WHERE p.workspace_id=${scope.workspaceId} AND p.stem_snapshot IS NULL)
    OR EXISTS(SELECT 1 FROM opening_help_exposures h LEFT JOIN opening_turns t ON t.id=h.turn_id AND t.workspace_id=h.workspace_id
      WHERE h.workspace_id=${scope.workspaceId} AND h.delivered=true AND h.turn_id IS NOT NULL AND t.id IS NULL)
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
  // A rescan adds current facts but cannot repair omitted expressions in an old
  // immutable descriptor whose original text may no longer exist. Never rewrite
  // history or turn an old unknown into complete under the new interpretation.
  const unknown = await tx`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND (exact_content IS NULL OR exact_content->>'complete' IS DISTINCT FROM 'true'
      OR exact_content->>'grammar' IS DISTINCT FROM ${grammar}) LIMIT 1`;
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
  const descriptors = rows.map(row => descriptorSchema.safeParse(row.exact_content));
  if (descriptors.some(row => !row.success)) return { coverage: "unknown", exactExposed: false, familyExposed: false, reason: "曝光记录格式未知或不完整" };
  return { coverage: "complete", exactExposed: descriptors.some(row => row.success && row.data.expressions.includes(exact.expression)),
    familyExposed: descriptors.some(row => row.success && row.data.families.includes(exact.familyId)), reason: null };
}
