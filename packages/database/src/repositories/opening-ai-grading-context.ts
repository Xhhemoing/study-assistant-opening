import { readTeachingQuestionForGrading } from "./opening-teaching-question";
import { isDeepStrictEqual } from "node:util";
import { answerInterpretationMetadataSchema,aiGradingInputSchema, learningObservationSchema, type AiGradingInput, type LearningObservation, type Scope, type TeachingMisconception } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { admitLearningSources, learningError, lockLearningOwner } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import { readOpeningAnswerInterpretationMetadata } from "./opening-answer-interpretation-state";
import type { AnswerInterpretationMetadata } from "@aistudy/contracts";
import { openingAnswerInterpretationPriorCostUnresolved } from "./opening-answer-interpretation-ledger";
import { readOpeningPinnedTeachingChunks } from "./opening-grading-visual-references";

export interface OpeningAiGradingContext {
  observation: LearningObservation;
  stem: string;
  referenceText: string;
  misconceptions: TeachingMisconception[];
  sourceIds: string[];
  sourceVersions: Record<string, number>;
  referenceSources: { sourceId: string; sourceVersion: number; physicalPage: number }[];
  referenceSourceMetadata: { mime: string; bytes: number }[];
  workSource: { id: string; version: number; physicalPage: number } | null;
  workSourceMetadata: { mime: string; bytes: number } | null;
  existing: LearningObservation | null;
  answerRevision: number;
  operationId: string;
  interpretation?:AnswerInterpretationMetadata;
}

export const aiGradingClientKey = (input: AiGradingInput) => `ai-grade:${input.observationId}`;

/** The revision contract cannot replace a photo. An unchanged-text learner
 * correction is a judgement/metadata override, not consent to grade it again.
 * Compare immutable answers too, so pre-fix revisions are protected. */
export const isOpeningManualGradingRevision = (row: Record<string, unknown>) =>
  row.revision_kind === "replace" && row.ai_evaluation == null && row.answer === row.previous_answer
    && !answerInterpretationMetadataSchema.safeParse((row.submitted_intent as {answerInterpretation?:unknown}|null)?.answerInterpretation).success;

/** Resolve only the sealed answer and its captured question; never accept a client grading context. */
export async function readOpeningAiGradingContext(tx: TransactionSql, scope: Scope, raw: AiGradingInput, options: { readOnly?: boolean } = {}): Promise<OpeningAiGradingContext> {
  return readContextInternal(tx, scope, raw, options);
}

/** Seal only the student's owned photo. Losing a question reference cannot erase
 * an already issued answer; this path does not authorize model execution. */
export async function admitOpeningAiGradingWorkSource(tx: TransactionSql, scope: Scope, observationId: string) {
  const context = await readContextInternal(tx, scope, { observationId }, { photoAdmissionOnly: true });
  return { sourceIds: context.sourceIds, sourceVersions: context.sourceVersions };
}

async function readContextInternal(tx: TransactionSql, scope: Scope, raw: AiGradingInput,
  options: { readOnly?: boolean; photoAdmissionOnly?: true }): Promise<OpeningAiGradingContext> {
  let input = aiGradingInputSchema.parse(raw);
  if (!options.readOnly) await lockLearningOwner(tx, scope);
  const [owner] = await tx`SELECT id FROM users WHERE id=${scope.ownerUserId} AND disabled_at IS NULL ${options.readOnly ? tx`` : tx`FOR SHARE`}`;
  if (!owner) throw learningError("NOT_FOUND", "workspace owner unavailable");
  const [row] = await tx`SELECT o.*,previous.answer AS previous_answer,COALESCE(root.effective_head_id,root.id) AS current_head_id
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    LEFT JOIN opening_learning_observations previous ON previous.id=o.revises_observation_id
      AND previous.workspace_id=o.workspace_id AND previous.owner_user_id=o.owner_user_id
    JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id AND c.archived_at IS NULL
    WHERE o.id=${input.observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  if (!row) throw learningError("NOT_FOUND", "找不到这次作答");
  const sealedPhoto = row.grading_work_source as { id: string; version: number; physicalPage: number } | null;
  if (sealedPhoto) {
    if (input.workSourceId && (input.workSourceId !== sealedPhoto.id || input.workSourceVersion !== sealedPhoto.version || input.physicalPage !== sealedPhoto.physicalPage)) {
      throw learningError("CONFLICT", "作答照片已封存，请开始新作答以更换照片");
    }
    input = { ...input, workSourceId: sealedPhoto.id, workSourceVersion: sealedPhoto.version, physicalPage: sealedPhoto.physicalPage };
  }
  const observation = await qualifyObservationRevision(tx, scope, row);
  if (!observation.attemptId || !observation.problemId || !observation.itemVersionId) {
    throw learningError("VALIDATION", "请先关联题目并保存作答，再进行批改");
  }
  const [existingRow] = await tx`SELECT * FROM opening_learning_observations
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${aiGradingClientKey(input)}`;
  if (existingRow && !isDeepStrictEqual((existingRow.submitted_intent as { aiGrading?: { input?: unknown } } | null)?.aiGrading?.input, raw)
    && !isDeepStrictEqual((existingRow.submitted_intent as { aiGrading?: { input?: unknown } } | null)?.aiGrading?.input, input)) {
    throw learningError("CONFLICT", "这次作答已使用其他照片批改，请先查看当前结果");
  }
  if (existingRow && row.current_head_id !== existingRow.id) throw learningError("CONFLICT", "批改后作答已更正，请刷新查看当前结果");
  if (!existingRow && row.current_head_id !== input.observationId) throw learningError("CONFLICT", "作答已更正，请刷新后再批改");
  const interpretation=await readOpeningAnswerInterpretationMetadata(tx,scope,String(row.id));
  const ownInterpretation=(row.submitted_intent as {answerInterpretation?:unknown}|null)?.answerInterpretation;
  if (isOpeningManualGradingRevision(row)&&!ownInterpretation) throw learningError("CONFLICT", "已保留人工更正；未修改答案不会再次批改");
  if(ownInterpretation&&!interpretation)throw learningError("CONFLICT","校正版来源尚不可核对，未重新发送批改。");
  if(interpretation&&await openingAnswerInterpretationPriorCostUnresolved(tx,scope,String(row.id)))throw Object.assign(learningError("CONFLICT","原照片批改费用尚未确认；校正版已保存，不会另换请求重复发送。"),{reasonCode:"GRADING_UNKNOWN_COST"});
  // Deterministic span evaluation is authoritative for the original answer,
  // but photo admission only seals provenance; it must not reopen grading.
  if (observation.revisionKind === "retract" || (!options.photoAdmissionOnly && observation.verdictSource === "deterministic") || observation.aiEvaluation) {
    throw learningError("CONFLICT", "请查看已有结果，或先更正作答后再批改");
  }
  const [item] = await tx`SELECT v.*,a.source_ids AS attempt_source_ids FROM opening_learning_item_versions v
    JOIN opening_learning_attempts a ON a.item_version_id=v.id AND a.problem_id=v.problem_id
      AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id
    WHERE v.id=${observation.itemVersionId} AND a.id=${observation.attemptId}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND a.session_id=${observation.sessionId} AND a.submitted_at IS NOT NULL`;
  if (!item || typeof item.stem_snapshot !== "string" || !item.stem_snapshot.trim()) throw learningError("VALIDATION", "缺少完整题目，请补充题目后开始新练习");
  if (!options.photoAdmissionOnly && observation.eligibility?.usableForCurrentVersion !== "yes") throw learningError("CONFLICT", item.teaching_revision_id
    ? "原课堂内容或关联资料不可读取，请重新打开课程开始新练习" : "题目材料已变化，请刷新后重新开始这道题");
  if (!input.workSourceId && !observation.answer.trim()) throw learningError("VALIDATION", "请填写答案或选择作答照片");
  const sourceIds = [...new Set([...observation.sourceIds, ...Object.keys(observation.sourceVersions ?? {}),
    ...(observation.referenceSourceId ? [observation.referenceSourceId] : []), ...(input.workSourceId ? [input.workSourceId] : [])])].sort();
  if (!learningObservationSchema.shape.sourceIds.safeParse(sourceIds).success) {
    throw learningError("VALIDATION", "本次练习关联材料过多，请新建练习后再附作答照片");
  }
  const sources = options.photoAdmissionOnly ? [] : await admitLearningSources(tx, scope, sourceIds.filter(id => id !== input.workSourceId), { recordVersions: !options.readOnly, readOnly: options.readOnly });
  const sourceVersions: Record<string, number> = options.photoAdmissionOnly ? { ...observation.sourceVersions } : {};
  for (const source of sources) {
    const id = String(source.id), version = Number(source.version);
    const captured = observation.sourceVersions?.[id];
    if (captured == null || captured !== version) throw learningError("CONFLICT", "材料已更新，请选择当前版本重新作答");
    sourceVersions[id] = version;
  }
  let workSourceMetadata: OpeningAiGradingContext["workSourceMetadata"] = null;
  const workSource: OpeningAiGradingContext["workSource"] = input.workSourceId
    ? { id: input.workSourceId, version: input.workSourceVersion!, physicalPage: input.physicalPage! } : null;
  if (options.photoAdmissionOnly && !workSource) throw learningError("VALIDATION", "缺少已封存的作答照片");
  if (workSource) {
    // Classroom items have no synthetic material source. Their attempt sealed the original
    // teaching materials; a later student photo is added only to observation provenance.
    if (workSource.id === item.source_id || observation.referenceSourceId === workSource.id
      || item.teaching_revision_id != null && (item.attempt_source_ids as string[]).includes(workSource.id)) throw learningError("VALIDATION", "请选择自己的作答照片，不要选择原题或参考答案");
    const [photo] = await tx`SELECT id,mime,version,bytes,sha256,parse_state FROM opening_sources s
      WHERE s.id=${workSource.id} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      ${options.readOnly ? tx`` : tx`FOR SHARE`}`;
    if (!photo || Number(photo.version) !== workSource.version) throw learningError("CONFLICT", "作答材料已更新或不可读取，请刷新后重试");
    workSourceMetadata = { mime: String(photo.mime), bytes: Number(photo.bytes) };
    const image = ["image/jpeg", "image/png", "image/webp"].includes(String(photo.mime));
    if (image) {
      if (workSource.physicalPage !== 1) throw learningError("VALIDATION", "单张照片的页码应为1");
    } else if (photo.mime === "application/pdf" && photo.parse_state === "ready") {
      const [page] = await tx`SELECT id FROM opening_source_chunks WHERE source_id=${workSource.id}
        AND source_version=${workSource.version} AND page=${workSource.physicalPage} LIMIT 1`;
      if (!page) throw learningError("CONFLICT", "作答 PDF 的这一页尚不可读取");
    } else throw learningError("VALIDATION", "请选择 JPG、PNG、WebP 或已读取的 PDF 作答材料");
    if (!options.readOnly) await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${workSource.id},${workSource.version},${scope.workspaceId},${photo.bytes},${photo.sha256},'available')
      ON CONFLICT(source_id,version) DO NOTHING`;
    sourceVersions[workSource.id] = workSource.version;
  }
  if (options.photoAdmissionOnly) return { observation, stem: item.stem_snapshot, referenceText: "", misconceptions: [],
    sourceIds, sourceVersions, workSource, workSourceMetadata, referenceSources: [], referenceSourceMetadata: [], existing: null,
    answerRevision: Number(row.answer_revision), operationId: String(row.grading_operation_id ?? `ai-grade:${scope.workspaceId}:${input.observationId}`) };
  const teaching = await readTeachingQuestionForGrading(tx, scope, item);
  const referenceIds = sourceIds.filter(id => id !== input.workSourceId);
  const teachingRefs = teaching?.sourceRefs ?? (item.source_id ? [{ sourceId: String(item.source_id),
    version: sourceVersions[String(item.source_id)], chunkId: item.chunk_id == null ? null : String(item.chunk_id),
    page: item.physical_page == null ? null : Number(item.physical_page) }] : []);
  const pinnedChunks = await readOpeningPinnedTeachingChunks(tx, scope, teachingRefs, sourceVersions);
  const sourceChunks = referenceIds.length ? await tx`SELECT c.id,c.source_id,c.source_version,c.page,c.text,c.image_object_key,s.mime,s.bytes FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.version=c.source_version
    WHERE c.source_id=ANY(${referenceIds}::uuid[]) AND c.source_version::text=${tx.json(sourceVersions)}->>c.source_id::text
      AND (c.source_id=${observation.referenceSourceId} OR c.id=${item.chunk_id as string | null}
        OR c.source_id=${item.source_id as string | null} AND c.page IS NOT DISTINCT FROM ${item.physical_page as number | null})
    ORDER BY (c.source_id=${observation.referenceSourceId}) DESC NULLS LAST,c.page,c.id` : [];
  const chunks = [...new Map([...pinnedChunks, ...sourceChunks].map(chunk => [String(chunk.id), chunk])).values()];
  return { observation, stem: teaching?.stem ?? item.stem_snapshot,
    misconceptions: teaching?.misconceptions ?? [],
    referenceText: [teaching?.referenceText, ...chunks.map(chunk => String(chunk.text ?? ""))].filter(Boolean).join("\n\n").slice(0, 16000),
    referenceSourceMetadata: [...new Map(chunks.filter(chunk => chunk.image_object_key && chunk.page != null)
      .map(chunk => [`${chunk.source_id}:${chunk.source_version}:${chunk.page}`, { mime: String(chunk.mime), bytes: Number(chunk.bytes) }] as const)).values()],
    referenceSources: [...new Map(chunks.filter(chunk => chunk.image_object_key && chunk.page != null)
      .map(chunk => [`${chunk.source_id}:${chunk.source_version}:${chunk.page}`, { sourceId: String(chunk.source_id), sourceVersion: Number(chunk.source_version), physicalPage: Number(chunk.page) }] as const)).values()],
    sourceIds, sourceVersions, workSource, workSourceMetadata, existing: existingRow ? await qualifyObservationRevision(tx, scope, existingRow) : null,
    answerRevision: Number(row.answer_revision), operationId: String(row.grading_operation_id ?? `ai-grade:${scope.workspaceId}:${input.observationId}`),...(interpretation?{interpretation}:{}) };
}
