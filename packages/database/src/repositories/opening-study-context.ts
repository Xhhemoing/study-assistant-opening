import { readOpeningStudyIntentInTx } from "./opening-study-intent-events";
import { matrixExerciseStem, parseCanonicalMatrixExercise, spanProblemStem } from "@aistudy/domain";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import type { Sql, TransactionSql } from "postgres";
import { studyContextAnchorSchema, type Scope, type StudyContextAnchor } from "@aistudy/contracts";
import { learningError } from "./opening-learning-facts";

type Row = Record<string, unknown>;
const conflict = (message: string) => learningError("CONFLICT", message);

/** One resolver for teaching, attempts and reading entries. It never repairs or changes identities. */
export async function resolveOpeningStudyContext(
  tx: Sql | TransactionSql,
  scope: Scope,
  selection: StudyContextAnchor,
  expected: { courseId?: string | null; sessionId?: string | null; attemptId?: string | null; sourceIds?: readonly string[]; sourceAccess?: "ai" | "human_read"; associationOnly?: boolean } = {},
): Promise<StudyContextAnchor> {
  const input = studyContextAnchorSchema.parse(selection);
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!owner) throw learningError("NOT_FOUND", "workspace not found");
  const anchor: StudyContextAnchor = { purpose: input.purpose, courseId: input.courseId ?? null, activityId: input.activityId ?? null,
    blockId: input.blockId ?? null, contentVersion: input.contentVersion ?? null, attemptId: input.attemptId ?? expected.attemptId ?? null,
    itemVersionId: input.itemVersionId ?? null, sourceId: input.sourceId ?? null, sourceVersion: input.sourceVersion ?? null,
    chunkId: input.chunkId ?? null, page: input.page ?? null, kcMappingVersion: input.kcMappingVersion ?? null };
  function bind<K extends keyof StudyContextAnchor>(field: K, value: StudyContextAnchor[K]) {
    if (anchor[field] != null && anchor[field] !== value) throw conflict(`study context ${String(field)} mismatch; reopen the selected version`);
    anchor[field] = value;
  }
  if (expected.attemptId && input.attemptId && expected.attemptId !== input.attemptId) throw conflict("study context attempt mismatch");
  if (expected.courseId !== undefined && expected.courseId !== null) bind("courseId", expected.courseId);
  let session: Row | undefined;
  let attempt: Row | undefined;
  if (anchor.attemptId) {
    [attempt] = await tx`SELECT * FROM opening_learning_attempts WHERE id=${anchor.attemptId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!attempt) throw learningError("NOT_FOUND", "study attempt not found");
    if (expected.sessionId && attempt.session_id !== expected.sessionId) throw conflict("study attempt/session mismatch");
    bind("courseId", attempt.course_id as string | null);
    bind("activityId", attempt.activity_id as string);
    bind("itemVersionId", attempt.item_version_id as string | null);
    const saved = attempt.create_intent as { teachingBlock?: { blockId: string; contentVersion: number } };
    if (saved.teachingBlock) {
      bind("blockId", saved.teachingBlock.blockId);
      bind("contentVersion", saved.teachingBlock.contentVersion);
    }
  }
  const sessionId = expected.sessionId ?? (attempt?.session_id as string | undefined);
  if (sessionId) {
    [session] = await tx`SELECT * FROM opening_learning_sessions WHERE id=${sessionId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!session) throw learningError("NOT_FOUND", "study session not found");
    bind("courseId", session.course_id as string | null);
    bind("activityId", session.activity_id as string);
  }
  if (anchor.courseId) {
    const [course] = await tx`SELECT id FROM courses WHERE id=${anchor.courseId} AND workspace_id=${scope.workspaceId} AND (${expected.associationOnly === true} OR archived_at IS NULL) FOR SHARE`;
    if (!course) throw learningError("NOT_FOUND", "study course not found");
  }
  let activity: Row | undefined;
  if (anchor.activityId) {
    [activity] = await tx`SELECT * FROM opening_teaching_activities WHERE id=${anchor.activityId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!activity) throw learningError("NOT_FOUND", "study activity not found");
    bind("courseId", activity.course_id as string | null);
  }
  if (!expected.associationOnly && (anchor.contentVersion != null || anchor.blockId)) {
    if (!activity) throw conflict("teaching content version requires an activity");
    const [spec] = await tx`SELECT block_order,source_refs,version FROM opening_teaching_activity_specs
      WHERE activity_id=${anchor.activityId!} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!spec || Number(activity.content_version) !== anchor.contentVersion || Number(spec.version) !== anchor.contentVersion) {
      throw conflict("teaching content version unavailable; reopen the original context");
    }
    const blocks = spec.block_order as Array<{ blockId: string }>;
    if (anchor.blockId && !blocks.some(block => block.blockId === anchor.blockId)) throw conflict("block does not belong to the teaching content version");
    const allRefs = spec.source_refs as Array<{ sourceId: string; version?: string | number | null }>;
    for (const reference of allRefs) {
      if (reference.version == null || !Number.isInteger(Number(reference.version))) continue;
      const [available] = await tx`SELECT s.id FROM opening_sources s WHERE s.id=${reference.sourceId} AND s.workspace_id=${scope.workspaceId}
        AND s.upload_state='uploaded'
        AND (${expected.sourceAccess === "human_read"} OR NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id))
        AND (s.version=${Number(reference.version)} OR EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.source_id=s.id
          AND v.workspace_id=s.workspace_id AND v.version=${Number(reference.version)} AND v.availability='available'))
        AND EXISTS(SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=${Number(reference.version)}) FOR SHARE OF s`;
      if (!available) throw conflict("teaching reference material version unavailable; no switch to a newer version");
    }
    if (anchor.sourceId) {
      const refs = spec.source_refs as Array<{ sourceId: string; version?: string | number | null }>;
      const ref = refs.find(row => row.sourceId === anchor.sourceId);
      if (!ref) throw conflict("material does not belong to the teaching content");
      if (ref.version != null && Number.isInteger(Number(ref.version))) bind("sourceVersion", Number(ref.version));
    }
  }
  let itemSourceId: string | null = null;
  if (anchor.itemVersionId) {
    const [item] = await tx`SELECT * FROM opening_learning_item_versions WHERE id=${anchor.itemVersionId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!item) throw learningError("NOT_FOUND", "study item version not found");
    bind("courseId", item.course_id as string | null);
    itemSourceId = item.source_id as string;
    if (attempt && (item.problem_id !== attempt.problem_id || item.id !== attempt.item_version_id)) throw conflict("item version does not belong to attempt");
    // Reused problems can originate in an earlier activity. The attempt owns activity identity.
    if (!attempt && anchor.activityId && item.activity_id !== anchor.activityId) throw conflict("item version does not belong to activity");
    if (!attempt && !anchor.activityId) bind("activityId", item.activity_id as string);
    if (!anchor.sourceId || anchor.sourceId === item.source_id) {
      bind("sourceId", item.source_id as string);
      bind("sourceVersion", Number(item.source_version));
      if (!anchor.chunkId) anchor.chunkId = item.chunk_id as string | null;
      if (anchor.page == null) anchor.page = item.physical_page as number | null;
    }
  }
  if (anchor.sourceId && !expected.associationOnly) {
    if (expected.sourceIds?.length && !expected.sourceIds.includes(anchor.sourceId)) throw conflict("anchor material is outside turn source selection");
    const [source] = await tx`SELECT id,version FROM opening_sources WHERE id=${anchor.sourceId} AND workspace_id=${scope.workspaceId}
      AND upload_state='uploaded' AND (parse_state='ready' OR ${expected.sourceAccess === "human_read"})
      AND (${expected.sourceAccess === "human_read"} OR NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=${anchor.sourceId})) FOR SHARE`;
    if (!source) throw conflict("study material unavailable or excluded");
    if (anchor.chunkId) {
      const [chunk] = await tx`SELECT source_id,source_version,page FROM opening_source_chunks WHERE id=${anchor.chunkId} AND source_id=${anchor.sourceId} FOR SHARE`;
      if (!chunk) throw conflict("chunk does not belong to selected material");
      bind("sourceVersion", Number(chunk.source_version));
      bind("page", chunk.page as number | null);
    }
    if (anchor.sourceVersion == null) {
      const captured = attempt?.source_versions as Record<string, number> | undefined;
      anchor.sourceVersion = captured?.[anchor.sourceId] ?? Number(source.version);
    }
    if (anchor.sourceVersion !== Number(source.version)) {
      const [version] = await tx`SELECT version FROM opening_source_versions WHERE source_id=${anchor.sourceId}
        AND workspace_id=${scope.workspaceId} AND version=${anchor.sourceVersion} AND availability='available' FOR SHARE`;
      if (!version) throw conflict("selected material version unavailable; no switch to current version");
    }
    const [readable] = await tx`SELECT id FROM opening_source_chunks WHERE source_id=${anchor.sourceId} AND source_version=${anchor.sourceVersion}
      AND (${anchor.page ?? null}::int IS NULL OR page=${anchor.page ?? null}) LIMIT 1`;
    if (!readable) throw conflict("selected material version/page is unavailable");
    const inSession = (session?.source_ids as string[] | undefined)?.includes(anchor.sourceId);
    let inActivity = (activity?.source_ids as string[] | undefined)?.includes(anchor.sourceId);
    if (!activity && anchor.activityId) {
      const [originActivity] = await tx`SELECT source_ids FROM opening_teaching_activities WHERE id=${anchor.activityId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      inActivity = (originActivity?.source_ids as string[] | undefined)?.includes(anchor.sourceId);
    }
    if (anchor.courseId && !inSession && !inActivity && itemSourceId !== anchor.sourceId) {
      const [membership] = await tx`SELECT id FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
        AND course_id=${anchor.courseId} AND asset_type='source' AND asset_id=${anchor.sourceId} FOR SHARE`;
      if (!membership) throw conflict("selected material does not belong to study course");
    }
  }
  if (anchor.kcMappingVersion != null) {
    if (!anchor.courseId) throw conflict("knowledge mapping requires a course");
    const [mapping] = await tx`SELECT version FROM opening_course_knowledge WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND course_id=${anchor.courseId} FOR SHARE`;
    if (!mapping || Number(mapping.version) !== anchor.kcMappingVersion) throw conflict("knowledge mapping version unavailable");
  }
  if (!activity && anchor.activityId) {
    const [resolvedActivity] = await tx`SELECT course_id FROM opening_teaching_activities WHERE id=${anchor.activityId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!resolvedActivity) throw learningError("NOT_FOUND", "study activity not found");
    bind("courseId", resolvedActivity.course_id as string | null);
  }
  if (anchor.courseId) {
    const [resolvedCourse] = await tx`SELECT id FROM courses WHERE id=${anchor.courseId} AND workspace_id=${scope.workspaceId} AND (${expected.associationOnly === true} OR archived_at IS NULL) FOR SHARE`;
    if (!resolvedCourse) throw learningError("NOT_FOUND", "study course not found");
  }
  return studyContextAnchorSchema.parse(anchor);
}

export function openingCanonicalLanguageQuestion(value: unknown): string | null {
  const span = parseOpeningSpanExercise(value);
  if (span) return spanProblemStem(span);
  const matrix = parseCanonicalMatrixExercise(value);
  return matrix ? matrixExerciseStem(matrix) : null;
}

export function createOpeningStudyContextRepository(sql: Sql) {
  return { resolve: (scope: Scope, anchor: StudyContextAnchor, expected?: Parameters<typeof resolveOpeningStudyContext>[3]) =>
    sql.begin(tx => resolveOpeningStudyContext(tx, scope, anchor, expected)) as Promise<StudyContextAnchor>,
    sessionIntent: (scope: Scope, anchor: StudyContextAnchor) => sql.begin(async tx => {
      const resolved = await resolveOpeningStudyContext(tx, scope, anchor);
      if (!resolved.attemptId) return null;
      const [attempt] = await tx`SELECT session_id FROM opening_learning_attempts WHERE id=${resolved.attemptId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      return attempt ? readOpeningStudyIntentInTx(tx, scope, String(attempt.session_id)) : null;
    }),
    languageSupport: (scope: Scope, anchor: StudyContextAnchor) => sql.begin(async tx => {
      const resolved = await resolveOpeningStudyContext(tx, scope, anchor);
      if (!resolved.itemVersionId) return null;
      const [item] = await tx`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${resolved.itemVersionId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      return openingCanonicalLanguageQuestion(item?.evaluation_spec);
    }) as Promise<string | null> };

}
