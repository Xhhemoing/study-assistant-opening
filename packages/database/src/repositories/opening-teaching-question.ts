import type { Scope, TeachingBlockRef, TeachingSourceRef } from "@aistudy/contracts";
import { courseRouteActivityContextSchema, questionIdentitySchema, teachingMisconceptionsSchema, teachingQuestionInteractionSchema, teachingSourceRefSchema } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { checkArithmeticAnswer, type ResolvedCourseQuestion } from "@aistudy/domain";
import { learningError, type LearningSql } from "./opening-learning-facts";

type Block = { id: string; type: string; content: Record<string, unknown> };
export type TeachingQuestionSpec = {
  kind: "teaching_question"; specVersion: "teaching-question-v1";
  activityId: string; teachingUnitId: string; contentVersion: number;
  documentId: string; revisionId: string; revisionNumber: number; blockId: string;
  answerBlockId: string | null;
  sourceRefs?: TeachingSourceRef[];
  courseRequirement?: { id:string; revision:number; stableSkillId:string; requirementKey:string };
};

export function teachingQuestionBody(content: Record<string, unknown> | undefined): string | null {
  const value = content && [content.text, content.markdown, content.prompt, content.question, content.answer, content.solution]
    .find((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  return value ?? null;
}

export function teachingQuestionText(content: Record<string, unknown> | undefined): string | null {
  const value = teachingQuestionBody(content);
  if (!value) return null;
  const interaction = teachingQuestionInteractionSchema.safeParse(content?.interaction).data;
  return interaction?.kind === "choice" ? `${value}\n${interaction.options.map(option => `${option.id}. ${option.label}`).join("\n")}`
    : interaction?.kind === "numeric" && interaction.unit ? `${value}\n单位：${interaction.unit}` : value;
}

/** Only a published, owned teaching revision can issue this identity. Client text is never used. */
export async function readTeachingQuestionForAttempt(tx: TransactionSql, scope: Scope,
  activityId: string, input: { blockId: string; contentVersion: number }, sourceVersions: Record<string, number>) {
  const [row] = await tx`SELECT s.*,a.content_version,a.status,a.goal_json,a.source_ids AS activity_source_ids,r.id AS revision_id,r.blocks
    FROM opening_teaching_activity_specs s
    JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    JOIN opening_teaching_units u ON u.id=s.teaching_unit_id AND u.workspace_id=s.workspace_id AND u.owner_user_id=s.owner_user_id
      AND u.document_id=s.document_id
    JOIN library_revisions r ON r.document_id=s.document_id AND r.revision_number=s.revision_number AND r.workspace_id=s.workspace_id
    WHERE s.activity_id=${activityId} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} FOR SHARE OF a,s,r`;
  if (!row || Number(row.content_version) !== input.contentVersion || Number(row.version) !== input.contentVersion) {
    throw learningError("CONFLICT", "teaching content changed; reread before answering");
  }
  if (row.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot accept new attempts");
  const ordered = [...row.block_order as TeachingBlockRef[]].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex(block => block.blockId === input.blockId && block.role !== "answer_key"
    && (block.role === "prompt" || ["prompt", "question"].includes(block.blockType)));
  const blocks = row.blocks as Block[], prompt = blocks.find(block => block.id === input.blockId);
  if (prompt?.content.interaction !== undefined && !teachingQuestionInteractionSchema.safeParse(prompt.content.interaction).success) {
    throw learningError("VALIDATION", "teaching question interaction is invalid");
  }
  const stem = teachingQuestionText(prompt?.content);
  if (index < 0 || !prompt || !["prompt", "question"].includes(prompt.type) || !stem) {
    throw learningError("VALIDATION", "teaching question not found in the saved revision");
  }
  if ((row.activity_source_ids as string[]).some(sourceId => !(sourceId in sourceVersions))) {
    throw learningError("CONFLICT", "the question requires all original teaching materials");
  }
  const references = row.source_refs as TeachingSourceRef[];
  for (const reference of references) {
    const version = reference.version == null ? NaN : Number(reference.version);
    if (!(reference.sourceId in sourceVersions) || !Number.isInteger(version) || sourceVersions[reference.sourceId] !== version) {
      throw learningError("CONFLICT", "teaching reference material version changed or unknown; reread the teaching content");
    }
  }
  const following = ordered[index + 1];
  const answerBlock = following && (following.role === "answer_key" || ["answer_key", "solution"].includes(following.blockType))
    ? blocks.find(block => block.id === following.blockId && ["answer_key", "solution"].includes(block.type)) : undefined;
  const referenceAnswer = teachingQuestionText(answerBlock?.content);
  if (referenceAnswer && checkArithmeticAnswer(stem, referenceAnswer) === "incorrect") {
    throw learningError("VALIDATION", "这道题的参考解答与程序验算不一致，请先修正教学内容再作答");
  }
  const spec: TeachingQuestionSpec = { kind: "teaching_question", specVersion: "teaching-question-v1",
    activityId, teachingUnitId: String(row.teaching_unit_id), contentVersion: input.contentVersion,
    documentId: String(row.document_id), revisionId: String(row.revision_id), revisionNumber: Number(row.revision_number),
    blockId: input.blockId, answerBlockId: answerBlock?.id ?? null, sourceRefs: references };
  const route=(row.goal_json as {courseRoute?:unknown}|undefined)?.courseRoute;
  if(route!==undefined){const context=courseRouteActivityContextSchema.parse(route);
    spec.courseRequirement={id:context.requirementId,revision:context.requirementRevision,stableSkillId:context.stableSkillId,requirementKey:context.requirementKey};}
  return { spec, stem };
}

/** Resolve private identity from the owner's CURRENT publication, never an item/client claim.
 * Text-only blocks have a closed representation. Any unresolved visual/extra payload is
 * unknown, rather than interpreting missing figure extraction as confirmed absence.
 */
export async function readResolvedTeachingQuestion(tx: TransactionSql, scope: Scope, spec: TeachingQuestionSpec, lock = false): Promise<ResolvedCourseQuestion | null> {
  const [row] = await tx`SELECT r.blocks,s.block_order,s.source_refs
    FROM opening_teaching_activity_specs s
    JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    JOIN opening_teaching_units u ON u.id=s.teaching_unit_id AND u.workspace_id=s.workspace_id AND u.owner_user_id=s.owner_user_id AND u.document_id=s.document_id
    JOIN library_revisions r ON r.document_id=s.document_id AND r.workspace_id=s.workspace_id AND r.revision_number=s.revision_number
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} AND s.activity_id=${spec.activityId}
      AND s.teaching_unit_id=${spec.teachingUnitId} AND s.document_id=${spec.documentId} AND r.id=${spec.revisionId}
      AND s.revision_number=${spec.revisionNumber} AND s.version=${spec.contentVersion} AND a.content_version=s.version
      ${lock ? tx`FOR SHARE OF a,s,r` : tx``}`;
  if (!row || !Array.isArray(row.blocks) || !Array.isArray(row.block_order)) return null;
  const blocks = row.blocks as Block[], order = [...row.block_order as TeachingBlockRef[]].sort((a, b) => a.position - b.position);
  const index = order.findIndex(ref => ref.blockId === spec.blockId && ref.role === "prompt");
  const following = order[index + 1];
  if (index < 0 || !following || following.role !== "answer_key" || following.blockId !== spec.answerBlockId) return null;
  const prompt = blocks.find(block => block.id === spec.blockId && ["prompt", "question"].includes(block.type));
  const key = blocks.find(block => block.id === spec.answerBlockId && ["answer_key", "solution"].includes(block.type));
  if (!prompt || !key || typeof prompt.content.text !== "string" || !prompt.content.text.trim()) return null;
  const interaction = teachingQuestionInteractionSchema.safeParse(prompt.content.interaction);
  const answer = teachingQuestionText(key.content);
  if (!interaction.success || !answer) return null;
  const sources = teachingSourceRefSchema.array().min(1).max(32).safeParse(row.source_refs);
  if (!sources.success || sources.data.some(ref => ref.version == null)) return null;
  // Permission/version and unresolved source figures are checked on actual source rows.
  for (const ref of sources.data) {
    const [source] = await tx`SELECT s.version,s.mime,EXISTS(SELECT 1 FROM opening_source_chunks c
        WHERE c.source_id=s.id AND c.source_version=s.version AND c.image_object_key IS NOT NULL) AS has_figures
      FROM opening_sources s WHERE s.workspace_id=${scope.workspaceId} AND s.id=${ref.sourceId} AND s.upload_state='uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        AND (s.mime IN ('image/jpeg','image/png','image/webp') OR EXISTS(SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version))
        AND (${ref.chunkId ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM opening_source_chunks c
          WHERE c.source_id=s.id AND c.source_version=s.version AND c.id::text=${ref.chunkId ?? null}))
        AND (${ref.page ?? null}::int IS NULL OR EXISTS(SELECT 1 FROM opening_source_chunks c
          WHERE c.source_id=s.id AND c.source_version=s.version AND c.page=${ref.page ?? null}))
        ${lock ? tx`FOR SHARE OF s` : tx``}`;
    if (!source || Number(source.version) !== Number(ref.version) || source.has_figures || String(source.mime).startsWith("image/")) return null;
  }
  if (Object.keys(prompt.content).some(field => !["text", "markdown", "prompt", "question", "answer", "solution", "interaction"].includes(field))
    || /(?:图|figure|diagram|image|!\[|<img|\\includegraphics)/i.test(prompt.content.text)) return null;
  const identity = questionIdentitySchema.safeParse({ protocolVersion: "question-identity-1", identityRefId: spec.blockId,
    questionRef: { kind: "teaching_question", activityId: spec.activityId, documentId: spec.documentId,
      revisionNumber: spec.revisionNumber, contentVersion: spec.contentVersion, questionBlockId: spec.blockId, answerBlockId: spec.answerBlockId },
    sourceRefs: sources.data, conditionRefs: [{ kind: "block", documentId: spec.documentId, revisionNumber: spec.revisionNumber, blockId: spec.blockId }],
    figureRefs: [], answerRole: following.role });
  // `text` is required above and is the body consumed by both the learner and
  // exact evaluator. Compare only that body and parsed interaction (including
  // options/unit), not shadowed markdown/question/etc. Visual/unknown payloads
  // were rejected above; dropping shadow fields must not hide consumed figures.
  return identity.success ? { identity: identity.data, conditions: prompt.content.text, interaction: interaction.data, answer } : null;
}

/** Used by both live eligibility and batch qualification. The pinned revision is append-only. */
export function teachingQuestionIdentityMatches(db: LearningSql) {
  return db`(v.teaching_revision_id IS NULL AND v.teaching_block_id IS NULL
      AND (v.source_id IS NOT NULL OR (v.source_version IS NULL AND v.physical_page IS NULL
        AND v.chunk_id IS NULL AND v.stem_snapshot ~ '[^[:space:]]'))
    OR v.teaching_revision_id IS NOT NULL AND v.teaching_block_id IS NOT NULL
      AND v.evaluation_spec->>'kind'='teaching_question' AND v.evaluation_spec->>'specVersion'='teaching-question-v1'
      AND v.evaluation_spec->>'revisionId'=v.teaching_revision_id::text
      AND v.evaluation_spec->>'blockId'=v.teaching_block_id::text
      AND v.evaluation_spec->>'activityId'=v.activity_id::text
      AND EXISTS (SELECT 1 FROM library_revisions teaching_revision
        JOIN opening_teaching_units teaching_unit ON teaching_unit.document_id=teaching_revision.document_id
          AND teaching_unit.workspace_id=v.workspace_id AND teaching_unit.owner_user_id=v.owner_user_id
          AND teaching_unit.id::text=v.evaluation_spec->>'teachingUnitId'
        CROSS JOIN LATERAL jsonb_array_elements(teaching_revision.blocks) teaching_block
        WHERE teaching_revision.id=v.teaching_revision_id AND teaching_revision.workspace_id=v.workspace_id
          AND teaching_revision.document_id::text=v.evaluation_spec->>'documentId'
          AND teaching_revision.revision_number::text=v.evaluation_spec->>'revisionNumber'
          AND teaching_block->>'id'=v.teaching_block_id::text AND teaching_block->>'type' IN ('prompt','question')
          AND left((SELECT candidate.value FROM jsonb_array_elements_text(jsonb_build_array(
            teaching_block->'content'->>'text',teaching_block->'content'->>'markdown',
            teaching_block->'content'->>'prompt',teaching_block->'content'->>'question',
            teaching_block->'content'->>'answer',teaching_block->'content'->>'solution')) WITH ORDINALITY candidate(value,position)
            WHERE candidate.value ~ '[^[:space:]]' ORDER BY candidate.position LIMIT 1)
            || CASE teaching_block->'content'->'interaction'->>'kind'
              WHEN 'choice' THEN chr(10) || (SELECT string_agg((option->>'id') || '. ' || (option->>'label'),chr(10) ORDER BY position)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(teaching_block->'content'->'interaction'->'options')='array'
                  THEN teaching_block->'content'->'interaction'->'options' ELSE '[]'::jsonb END) WITH ORDINALITY choices(option,position))
              WHEN 'numeric' THEN CASE WHEN coalesce(teaching_block->'content'->'interaction'->>'unit','')<>''
                THEN chr(10) || '单位：' || (teaching_block->'content'->'interaction'->>'unit') ELSE '' END
              ELSE '' END,2000)=v.stem_snapshot))`;
}

/** Card variants are generated from card text, not from the private lineage's
 * source bytes. Keep those stored refs for version/privacy fences, but do not
 * present them (including a student's old photo) as this new question's evidence. */
function cardVariantLineageOnly(spec: TeachingQuestionSpec, refs: TeachingSourceRef[], row: Record<string, unknown>): boolean {
  const intent = row.create_intent as Record<string, unknown> | null;
  if (!intent || intent.kind !== "card_review_variant" || typeof intent.cardId !== "string" || !intent.cardId
    || !Number.isSafeInteger(intent.cardContentVersion) || Number(intent.cardContentVersion) < 1
    || !Number.isSafeInteger(intent.reviewReps) || Number(intent.reviewReps) < 0
    || !Number.isSafeInteger(intent.privacyEpoch) || Number(intent.privacyEpoch) < 0
    || spec.activityId !== row.activity_id || spec.revisionId !== row.teaching_revision_id || spec.blockId !== row.teaching_block_id
    || intent.variantRevisionId !== row.teaching_revision_id || intent.variantBlockId !== row.teaching_block_id
    || !Number.isSafeInteger(spec.contentVersion) || spec.contentVersion < 1 || intent.variantContentVersion !== spec.contentVersion
    || !intent.sourceVersions || typeof intent.sourceVersions !== "object" || Array.isArray(intent.sourceVersions)) return false;
  const versions = intent.sourceVersions as Record<string, unknown>;
  const ids = Object.keys(versions);
  return refs.length === ids.length && new Set(refs.map(ref => ref.sourceId)).size === refs.length
    && refs.every(ref => ref.chunkId == null && ref.page == null && ref.version != null
      && Number.isSafeInteger(versions[ref.sourceId]) && Number(versions[ref.sourceId]) >= 0
      && Number(ref.version) === versions[ref.sourceId]);
}

/** Read the immutable question and its hidden answer only for server-side grading. */
export async function readTeachingQuestionForGrading(tx: TransactionSql, scope: Scope, item: Record<string, unknown>) {
  if (item.teaching_revision_id == null) return null;
  const [row] = await tx`SELECT r.blocks,v.evaluation_spec,v.activity_id,v.teaching_revision_id,v.teaching_block_id,a.create_intent,s.block_order AS current_block_order FROM opening_learning_item_versions v
    JOIN library_revisions r ON r.id=v.teaching_revision_id AND r.workspace_id=v.workspace_id
    JOIN opening_teaching_activities a ON a.id=v.activity_id AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id
    LEFT JOIN opening_teaching_activity_specs s ON s.activity_id=v.activity_id AND s.workspace_id=v.workspace_id AND s.owner_user_id=v.owner_user_id
      AND s.document_id=r.document_id AND s.revision_number=r.revision_number AND s.version::text=v.evaluation_spec->>'contentVersion'
    WHERE v.id=${String(item.id)} AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND ${teachingQuestionIdentityMatches(tx)}`;
  if (!row) throw learningError("CONFLICT", "保存的课堂题目已不可读取，请重新打开课程");
  const spec = (row.evaluation_spec ?? item.evaluation_spec) as TeachingQuestionSpec, blocks = row.blocks as Block[];
  // Ordinary AI grading remains compatible with legacy/visual questions, without
  // upgrading their authority. When exact resolution is available, use the
  // owner's saved pair, never a separate answer/identity supplied by a caller.
  const resolved = await readResolvedTeachingQuestion(tx, scope, spec);
  if (Array.isArray(row.current_block_order)) {
    const order = [...row.current_block_order as TeachingBlockRef[]].sort((a, b) => a.position - b.position);
    const index = order.findIndex(ref => ref.blockId === spec.blockId);
    const paired = order[index + 1];
    if (index < 0 || spec.answerBlockId && (!paired || paired.role !== "answer_key" || paired.blockId !== spec.answerBlockId)) {
      throw learningError("CONFLICT", "保存的课堂答案与题目绑定不一致，请重新打开课程");
    }
  }
  const stem = teachingQuestionText(blocks.find(block => block.id === spec.blockId)?.content);
  if (!stem) throw learningError("CONFLICT", "保存的课堂题目已不可读取，请重新打开课程");
  const answer = blocks.find(block => block.id === spec.answerBlockId && ["answer_key", "solution"].includes(block.type));
  const text = resolved?.answer ?? teachingQuestionText(answer?.content);
  if (text && checkArithmeticAnswer(stem, text) === "incorrect") {
    throw learningError("CONFLICT", "原题参考解答与程序验算不一致，原答案已保留，请先核对题目");
  }
  const rubric = answer?.content.rubric ?? answer?.content.criteria ?? answer?.content.scoringCriteria;
  const misconceptions = teachingMisconceptionsSchema.safeParse(answer?.content.misconceptions).data ?? [];
  const sourceRefs = teachingSourceRefSchema.array().max(64).parse(spec.sourceRefs ?? []);
  return { stem, misconceptions, sourceRefs: cardVariantLineageOnly(spec, sourceRefs, row) ? [] : sourceRefs, referenceText: [text ? `课堂保存的参考解答（由教学内容生成，需结合题意判断）：\n${text}` : "",
    rubric ? `评分要点：\n${typeof rubric === "string" ? rubric : JSON.stringify(rubric)}` : ""].filter(Boolean).join("\n\n") };
}
