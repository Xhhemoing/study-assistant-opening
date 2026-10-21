import { isDeepStrictEqual } from "node:util";
import { aiGradingInputSchema, learningObservationSchema, type AiGradingInput, type LearningObservation, type Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { admitLearningSources, learningError, lockLearningOwner } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";

export interface OpeningAiGradingContext {
  observation: LearningObservation;
  stem: string;
  referenceText: string;
  sourceIds: string[];
  sourceVersions: Record<string, number>;
  workSource: { id: string; version: number; physicalPage: number } | null;
  existing: LearningObservation | null;
}

export const aiGradingClientKey = (input: AiGradingInput) => `ai-grade:${input.observationId}`;

/** Resolve only the sealed answer and its captured question; never accept a client grading context. */
export async function readOpeningAiGradingContext(tx: TransactionSql, scope: Scope, raw: AiGradingInput): Promise<OpeningAiGradingContext> {
  const input = aiGradingInputSchema.parse(raw);
  await lockLearningOwner(tx, scope);
  const [row] = await tx`SELECT o.*,COALESCE(root.effective_head_id,root.id) AS current_head_id
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id AND c.archived_at IS NULL
    WHERE o.id=${input.observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  if (!row) throw learningError("NOT_FOUND", "找不到这次作答");
  const observation = await qualifyObservationRevision(tx, scope, row);
  if (!observation.attemptId || !observation.problemId || !observation.itemVersionId) {
    throw learningError("VALIDATION", "请先关联题目并保存作答，再进行批改");
  }
  const [existingRow] = await tx`SELECT * FROM opening_learning_observations
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${aiGradingClientKey(input)}`;
  if (existingRow && !isDeepStrictEqual((existingRow.submitted_intent as { aiGrading?: { input?: unknown } } | null)?.aiGrading?.input, input)) {
    throw learningError("CONFLICT", "这次作答已使用其他照片批改，请先查看当前结果");
  }
  if (existingRow && row.current_head_id !== existingRow.id) throw learningError("CONFLICT", "批改后作答已更正，请刷新查看当前结果");
  if (!existingRow && row.current_head_id !== input.observationId) throw learningError("CONFLICT", "作答已更正，请刷新后再批改");
  if (observation.revisionKind === "retract" || observation.verdictSource === "deterministic" || observation.aiEvaluation) {
    throw learningError("CONFLICT", "请查看已有结果，或先更正作答后再批改");
  }
  const [item] = await tx`SELECT v.* FROM opening_learning_item_versions v
    JOIN opening_learning_attempts a ON a.item_version_id=v.id AND a.problem_id=v.problem_id
      AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id
    WHERE v.id=${observation.itemVersionId} AND a.id=${observation.attemptId}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND a.session_id=${observation.sessionId} AND a.submitted_at IS NOT NULL`;
  if (!item || typeof item.stem_snapshot !== "string" || !item.stem_snapshot.trim()) throw learningError("VALIDATION", "缺少完整题目，请补充题目后开始新练习");
  if (observation.eligibility?.usableForCurrentVersion !== "yes") throw learningError("CONFLICT", "题目材料已变化，请刷新后重新开始这道题");
  if (!input.workSourceId && !observation.answer.trim()) throw learningError("VALIDATION", "请填写答案或选择作答照片");
  const sourceIds = [...new Set([...observation.sourceIds, ...Object.keys(observation.sourceVersions ?? {}),
    ...(observation.referenceSourceId ? [observation.referenceSourceId] : []), ...(input.workSourceId ? [input.workSourceId] : [])])].sort();
  if (!learningObservationSchema.shape.sourceIds.safeParse(sourceIds).success) {
    throw learningError("VALIDATION", "本次练习关联材料过多，请新建练习后再附作答照片");
  }
  const sources = await admitLearningSources(tx, scope, sourceIds.filter(id => id !== input.workSourceId));
  const sourceVersions: Record<string, number> = {};
  for (const source of sources) {
    const id = String(source.id), version = Number(source.version);
    const captured = observation.sourceVersions?.[id];
    if (captured == null || captured !== version) throw learningError("CONFLICT", "材料已更新，请选择当前版本重新作答");
    sourceVersions[id] = version;
  }
  const workSource = input.workSourceId ? { id: input.workSourceId, version: input.workSourceVersion!, physicalPage: input.physicalPage! } : null;
  if (workSource) {
    if (workSource.id === item.source_id || observation.referenceSourceId === workSource.id) throw learningError("VALIDATION", "请选择自己的作答照片，不要选择原题或参考答案");
    const [photo] = await tx`SELECT id,mime,version,bytes,sha256,parse_state FROM opening_sources s
      WHERE s.id=${workSource.id} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      FOR SHARE`;
    if (!photo || Number(photo.version) !== workSource.version) throw learningError("CONFLICT", "作答材料已更新或不可读取，请刷新后重试");
    const image = ["image/jpeg", "image/png", "image/webp"].includes(String(photo.mime));
    if (image) {
      if (workSource.physicalPage !== 1) throw learningError("VALIDATION", "单张照片的页码应为1");
    } else if (photo.mime === "application/pdf" && photo.parse_state === "ready") {
      const [page] = await tx`SELECT id FROM opening_source_chunks WHERE source_id=${workSource.id}
        AND source_version=${workSource.version} AND page=${workSource.physicalPage} LIMIT 1`;
      if (!page) throw learningError("CONFLICT", "作答 PDF 的这一页尚不可读取");
    } else throw learningError("VALIDATION", "请选择 JPG、PNG、WebP 或已读取的 PDF 作答材料");
    await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${workSource.id},${workSource.version},${scope.workspaceId},${photo.bytes},${photo.sha256},'available')
      ON CONFLICT(source_id,version) DO NOTHING`;
    sourceVersions[workSource.id] = workSource.version;
  }
  const referenceIds = sourceIds.filter(id => id !== input.workSourceId);
  const chunks = referenceIds.length ? await tx`SELECT c.source_id,c.page,c.text FROM opening_source_chunks c
    WHERE c.source_id=ANY(${referenceIds}::uuid[]) AND c.source_version::text=${tx.json(sourceVersions)}->>c.source_id::text
      AND (c.source_id=${observation.referenceSourceId} OR c.id=${item.chunk_id as string | null}
        OR c.source_id=${item.source_id as string} AND c.page IS NOT DISTINCT FROM ${item.physical_page as number | null})
    ORDER BY (c.source_id=${observation.referenceSourceId}) DESC NULLS LAST,c.page,c.id LIMIT 24` : [];
  return { observation, stem: item.stem_snapshot, referenceText: chunks.map(chunk => String(chunk.text ?? "")).join("\n\n").slice(0, 16000),
    sourceIds, sourceVersions, workSource, existing: existingRow ? await qualifyObservationRevision(tx, scope, existingRow) : null };
}
