import type { Scope, TeachingBlockRef, TeachingSourceRef } from "@aistudy/contracts";
import { courseRouteActivityContextSchema, teachingMisconceptionsSchema, teachingQuestionInteractionSchema, teachingSourceRefSchema } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { checkArithmeticAnswer } from "@aistudy/domain";
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

export function teachingQuestionText(content: Record<string, unknown> | undefined): string | null {
  const value = content && [content.text, content.markdown, content.prompt, content.question, content.answer, content.solution]
    .find((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
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

/** Read the immutable question and its hidden answer only for server-side grading. */
export async function readTeachingQuestionForGrading(tx: TransactionSql, scope: Scope, item: Record<string, unknown>) {
  if (item.teaching_revision_id == null) return null;
  const [row] = await tx`SELECT r.blocks FROM opening_learning_item_versions v
    JOIN library_revisions r ON r.id=v.teaching_revision_id AND r.workspace_id=v.workspace_id
    WHERE v.id=${String(item.id)} AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND ${teachingQuestionIdentityMatches(tx)}`;
  if (!row) throw learningError("CONFLICT", "保存的课堂题目已不可读取，请重新打开课程");
  const spec = item.evaluation_spec as TeachingQuestionSpec, blocks = row.blocks as Block[];
  const stem = teachingQuestionText(blocks.find(block => block.id === spec.blockId)?.content);
  if (!stem) throw learningError("CONFLICT", "保存的课堂题目已不可读取，请重新打开课程");
  const answer = blocks.find(block => block.id === spec.answerBlockId && ["answer_key", "solution"].includes(block.type));
  const text = teachingQuestionText(answer?.content);
  if (text && checkArithmeticAnswer(stem, text) === "incorrect") {
    throw learningError("CONFLICT", "原题参考解答与程序验算不一致，原答案已保留，请先核对题目");
  }
  const rubric = answer?.content.rubric ?? answer?.content.criteria ?? answer?.content.scoringCriteria;
  const misconceptions = teachingMisconceptionsSchema.safeParse(answer?.content.misconceptions).data ?? [];
  const sourceRefs = teachingSourceRefSchema.array().max(64).parse(spec.sourceRefs ?? []);
  return { stem, misconceptions, sourceRefs, referenceText: [text ? `课堂保存的参考解答（由教学内容生成，需结合题意判断）：\n${text}` : "",
    rubric ? `评分要点：\n${typeof rubric === "string" ? rubric : JSON.stringify(rubric)}` : ""].filter(Boolean).join("\n\n") };
}
