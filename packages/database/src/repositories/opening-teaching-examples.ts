import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Sql, TransactionSql } from "postgres";
import { teachingExampleRequestSchema, teachingExampleTargetSchema, teachingExampleStatusSchema, teachingExampleProposalSchema, teachingSourceRefSchema, teachingBlockRefSchema,
  type Scope, type TeachingExampleRequest, type TeachingExampleTarget, type TeachingExampleProposal, type TeachingExampleStatus } from "@aistudy/contracts";
import { createOpeningCourseReadySourcesRepository } from "./opening-course-ready-sources";
import { learningError, learningIso, lockWorkspaceLearningHistory, lockLearningOwner } from "./opening-learning-facts";
import { assertOpeningCourseRouteCurrent } from "./opening-course-route-origin";
import { createLibraryRepository } from "./library";
import { readOpeningAiGradingLedger } from "./opening-ai-grading-ledger";
import type { OpeningJobScope } from "./opening-job-execution";

const openingMaterialPurposePinSchema = z.object({
  courseId: z.string().uuid().nullable(), materialUse: z.literal("teaching"),
  sources: z.array(z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(),
    membershipId: z.string().uuid().nullable(), purposeRevision: z.string().nullable(),
    purpose: z.enum(["teaching", "practice", "mock_exam", "reference"]).nullable() }).strict()).max(64),
}).strict();
const blockSchema = z.object({ id: z.string().uuid(), type: z.string(), content: z.record(z.string(), z.unknown()) }).passthrough();
/** Private payload, a strict discriminant on the existing legal compile job kind. */
export const teachingExampleJobPayloadSchema = z.object({
  mode: z.literal("example"), request: teachingExampleRequestSchema,
  originalExample: z.string().min(1).max(12000),
  sourceRefs: z.array(teachingSourceRefSchema).min(1).max(64),
  purposePin: openingMaterialPurposePinSchema,
  activitySourceIds: z.array(z.string().uuid()).max(64),
  blocks: z.array(blockSchema).max(498), blockOrder: z.array(teachingBlockRefSchema).max(498),
  estimatedCents: z.number().int().nonnegative().safe(),
}).strict();
export type TeachingExampleJobPayload = z.infer<typeof teachingExampleJobPayloadSchema>;
const operationKey = (id: string) => `teaching-example:${id}`;
const conflict = (message: string) => learningError("CONFLICT", message);

async function snapshot(tx: TransactionSql, scope: Scope, target: TeachingExampleTarget, lock = false) {
  const [owner] = await tx`SELECT id FROM users WHERE id=${scope.ownerUserId} AND disabled_at IS NULL FOR SHARE`;
  if (!owner) throw learningError("NOT_FOUND", "学习账号暂不可用。");
  const [row] = await tx`SELECT s.*,r.blocks,r.id AS revision_id,a.status,a.generate_status,a.source_ids,a.goal_json,a.create_intent,
      a.content_version,a.course_id,d.current_revision_number
    FROM opening_teaching_activity_specs s
    JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    JOIN opening_teaching_units u ON u.id=s.teaching_unit_id AND u.workspace_id=s.workspace_id AND u.owner_user_id=s.owner_user_id AND u.document_id=s.document_id
    JOIN library_documents d ON d.id=s.document_id AND d.workspace_id=s.workspace_id AND d.deleted_at IS NULL
    JOIN library_revisions r ON r.document_id=d.id AND r.workspace_id=s.workspace_id AND r.revision_number=s.revision_number
    WHERE s.activity_id=${target.activityId} AND s.document_id=${target.documentId}
      AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
    ${lock ? tx`FOR UPDATE OF a,s,u,d` : tx``}`;
  if (!row) throw learningError("NOT_FOUND", "找不到当前发布的例题。");
  if (Number(row.content_version) !== target.contentVersion || Number(row.version) !== target.contentVersion
    || Number(row.revision_number) !== target.revisionNumber || Number(row.current_revision_number) !== target.revisionNumber) throw conflict("例题发布版本已变化，请重新读取。");
  if (row.status === "completed" || ["queued", "generating", "unknown"].includes(String(row.generate_status))) throw conflict("当前整课任务尚未结束或费用未知，未创建例题请求。");
  if ((row.goal_json as Record<string, unknown>)?.spanCourseBinding || (row.create_intent as Record<string, unknown>)?.protocol === "span-lesson-v1") throw conflict("此专用课堂不支持通用例题生成。");
  await assertOpeningCourseRouteCurrent(tx, scope, target.activityId);
  const blocks = z.array(blockSchema).max(498).parse(row.blocks), blockOrder = z.array(teachingBlockRefSchema).max(498).parse(row.block_order);
  const ref = blockOrder.find(item => item.blockId === target.blockId && item.role === "example" && item.blockType === "example");
  const block = blocks.find(item => item.id === target.blockId && item.type === "example");
  if (!ref || !block || typeof block.content.text !== "string" || !block.content.text.trim()
    || Object.keys(block.content).some(key => !["text", "citedChunkIds", "rejectedCitationCount", "citationBinding", "rewriteOf", "generatedExample"].includes(key))) throw conflict("请选择当前发布的纯文字例题，不会从隐藏答案或题库生成。");
  const sourceRefs = z.array(teachingSourceRefSchema).min(1).max(64).parse(row.source_refs);
  for (const ref of sourceRefs) {
    if (ref.version == null || !Number.isSafeInteger(Number(ref.version))) throw conflict("例题材料版本不可确认。");
    const [source] = await tx`SELECT s.id FROM opening_sources s WHERE s.id=${ref.sourceId} AND s.workspace_id=${scope.workspaceId}
      AND s.version=${Number(ref.version)} AND s.upload_state='uploaded'
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      AND (${ref.chunkId ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version AND c.id::text=${ref.chunkId ?? null}))
      AND (${ref.page ?? null}::int IS NULL OR EXISTS(SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version AND c.page=${ref.page ?? null})) FOR SHARE OF s`;
    if (!source) throw conflict("例题来源已变化或不可读取。");
  }
  return { row, blocks, blockOrder, sourceRefs, originalExample: block.content.text };
}

export function createOpeningTeachingExamplesRepository(sql: Sql) {
  const purposes = createOpeningCourseReadySourcesRepository(sql);
  async function read(scope: Scope, id: string): Promise<TeachingExampleStatus> {
    const [job] = await sql`SELECT * FROM opening_jobs WHERE id=${id} AND workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND kind='compile-teaching-unit' AND payload->>'mode'='example'`;
    if (!job) throw learningError("NOT_FOUND", "例题请求不存在。");
    const payload = teachingExampleJobPayloadSchema.parse(job.payload);
    // An immutable revision, not transport/job completion, proves publication.
    const [published] = await sql`SELECT revision_number,blocks FROM library_revisions WHERE workspace_id=${scope.workspaceId}
      AND document_id=${payload.request.target.documentId} AND reason=${operationKey(id)}`;
    const publishedBlocks = published ? z.array(blockSchema).parse(published.blocks) : [];
    const example = publishedBlocks.find(block => block.type === "example" && (block.content.generatedExample as { operationId?: string })?.operationId === id);
    const solution = publishedBlocks.find(block => block.type === "steps" && (block.content.generatedExample as { operationId?: string })?.operationId === id);
    const publication = published && example && solution ? { documentId: payload.request.target.documentId, revisionNumber: Number(published.revision_number),
      contentVersion: payload.request.target.contentVersion + 1, exampleBlockId: example.id, solutionBlockId: solution.id,
      mathematicalStatus: "unchecked" as const, assistance: "revealed" as const, masteryEvidence: false as const } : null;
    const ledger = await readOpeningAiGradingLedger(sql, scope, operationKey(id));
    const state = publication ? "succeeded" : ledger === "unknown" || ledger === "in_flight" && job.state !== "running" || job.state === "outcome_unknown" ? "outcome_unknown"
      : job.state === "succeeded" ? "failed" : String(job.state);
    return teachingExampleStatusSchema.parse({ operationId: id, clientKey: payload.request.clientKey, target: payload.request.target, state,
      estimatedCents: payload.estimatedCents, estimateIsCap: false, publication, costState: ledger, createdAt: learningIso(job.created_at) });
  }
  return {
    read,
    ledger: (scope: Scope, id: string) => readOpeningAiGradingLedger(sql, scope, operationKey(id)),
    async findTarget(scope: Scope, target: TeachingExampleTarget): Promise<TeachingExampleStatus | null> {
      const [job] = await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND kind='compile-teaching-unit' AND payload->>'mode'='example'
        AND payload->'request'->'target'->>'activityId'=${target.activityId}
        AND payload->'request'->'target'->>'documentId'=${target.documentId}
        AND payload->'request'->'target'->>'blockId'=${target.blockId}
        ORDER BY created_at DESC,id DESC LIMIT 1`;
      return job ? read(scope, String(job.id)) : null;
    },
    async find(scope: Scope, clientKey: string): Promise<TeachingExampleStatus | null> {
      const [job] = await sql`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND key=${`teaching-example:${clientKey}`} AND kind='compile-teaching-unit' AND payload->>'mode'='example'`;
      return job ? read(scope, String(job.id)) : null;
    },
    async existing(scope: Scope, request: TeachingExampleRequest) {
      const [job] = await sql`SELECT id,payload FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND key=${`teaching-example:${request.clientKey}`}`;
      if (!job) return null;
      if (!isDeepStrictEqual(teachingExampleJobPayloadSchema.parse(job.payload).request, request)) throw conflict("相同 clientKey 的例题请求内容不一致。");
      return read(scope, String(job.id));
    },
    async context(scope: Scope, target: TeachingExampleTarget) {
      teachingExampleTargetSchema.parse(target);
      return sql.begin(async tx => {
        await lockLearningOwner(tx, scope);
        const current = await snapshot(tx, scope, target);
        const sourceIds = [...new Set([...(current.row.source_ids as string[]), ...current.sourceRefs.map(ref => ref.sourceId)])].sort();
        const purposePin = await purposes.readMaterialPurposePin(scope, { courseId: current.row.course_id as string | null, sourceIds, materialUse: "teaching" });
        return { ...current, purposePin };
      });
    },
    async request(scope: Scope, raw: TeachingExampleRequest, estimatedCents: number) {
      const request = teachingExampleRequestSchema.parse(raw);
      const replay = await this.existing(scope, request); if (replay) return replay;
      const context = await this.context(scope, request.target);
      const id = randomUUID();
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope); await lockLearningOwner(tx, scope);
        const [prior] = await tx`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND key=${`teaching-example:${request.clientKey}`}`;
        if (prior) return;
        const current = await snapshot(tx, scope, request.target, true);
        if (!isDeepStrictEqual(current.row.source_ids, context.row.source_ids) || !isDeepStrictEqual(current.blocks, context.blocks) || !isDeepStrictEqual(current.blockOrder, context.blockOrder)
          || !isDeepStrictEqual(current.sourceRefs, context.sourceRefs)) throw conflict("例题快照已变化。");
        await purposes.assertMaterialPurposePin(scope, context.purposePin, tx);
        const previous = await tx`SELECT id FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND kind='compile-teaching-unit' AND payload->>'mode'='example'
          AND payload->'request'->'target'->>'activityId'=${request.target.activityId}
          AND payload->'request'->'target'->>'documentId'=${request.target.documentId}
          AND payload->'request'->'target'->>'blockId'=${request.target.blockId}
          AND (state IN ('queued','running','outcome_unknown') OR EXISTS(SELECT 1 FROM opening_budget_reservations b WHERE b.workspace_id=${scope.workspaceId}
            AND (b.request_id='teaching-example:' || opening_jobs.id::text OR left(b.request_id,length('teaching-example:' || opening_jobs.id::text)+1)='teaching-example:' || opening_jobs.id::text || ':')
            AND (b.outcome_unknown_at IS NOT NULL OR COALESCE(b.pending_reconcile_cents,0)>0 OR b.state='reserved' AND b.execution_claimed_at IS NOT NULL))) LIMIT 1`;
        if (previous.length) throw conflict("该例题已有进行中或费用未知的请求，请只读恢复原请求。");
        const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        const payload = teachingExampleJobPayloadSchema.parse({ mode: "example", request, originalExample: current.originalExample,
          blocks: current.blocks, blockOrder: current.blockOrder, sourceRefs: current.sourceRefs, activitySourceIds: current.row.source_ids, purposePin: context.purposePin, estimatedCents });
        await tx`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,privacy_epoch)
          VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${`teaching-example:${request.clientKey}`},'compile-teaching-unit',${tx.json(payload as never)},${workspace!.privacy_epoch})`;
        await tx`INSERT INTO opening_outbox(workspace_id,job_id,topic,payload) VALUES(${scope.workspaceId},${id},'opening.job.enqueue',${tx.json({ jobId: id, kind: "compile-teaching-unit" })})`;
      });
      return (await this.existing(scope, request))!;
    },
    async assertCurrent(scope: OpeningJobScope, payload: TeachingExampleJobPayload) {
      await sql.begin(async tx => {
        await lockLearningOwner(tx, scope);
        const current = await snapshot(tx, scope, payload.request.target);
        if (!isDeepStrictEqual(current.row.source_ids, payload.activitySourceIds)) throw conflict("课堂材料选择已变化。");
        if (!isDeepStrictEqual(current.blocks, payload.blocks) || !isDeepStrictEqual(current.blockOrder, payload.blockOrder)
          || !isDeepStrictEqual(current.sourceRefs, payload.sourceRefs)) throw conflict("例题发布快照已变化。");
        await purposes.assertMaterialPurposePin(scope, payload.purposePin, tx);
      });
    },
    async publish(scope: OpeningJobScope, id: string, payload: TeachingExampleJobPayload, raw: TeachingExampleProposal) {
      const proposal = teachingExampleProposalSchema.parse(raw);
      const normalizedProblem = proposal.problem.normalize("NFKC").replace(/\s+/g, "");
      if (payload.originalExample.normalize("NFKC").replace(/\s+/g, "").includes(normalizedProblem)) throw conflict("新例题重复原正文。");
      if (!scope.jobExecution || scope.jobExecution.id !== id) throw conflict("缺少例题执行凭据。");
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope); await lockLearningOwner(tx, scope);
        const [job] = await tx`SELECT payload FROM opening_jobs WHERE id=${id} AND workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND kind='compile-teaching-unit'`;
        if (!job || !isDeepStrictEqual(teachingExampleJobPayloadSchema.parse(job.payload), payload)) throw conflict("例题执行身份不一致。");
        const current = await snapshot(tx, scope, payload.request.target, true);
        if (!isDeepStrictEqual(current.row.source_ids, payload.activitySourceIds)) throw conflict("课堂材料选择已变化。");
        if (!isDeepStrictEqual(current.blocks, payload.blocks) || !isDeepStrictEqual(current.blockOrder, payload.blockOrder)
          || !isDeepStrictEqual(current.sourceRefs, payload.sourceRefs)) throw conflict("例题发布快照已变化。");
        await purposes.assertMaterialPurposePin(scope, payload.purposePin, tx);
        const exampleId = randomUUID(), solutionId = randomUUID();
        const generatedExample = { operationId: id, target: payload.request.target, mathematicalStatus: "unchecked", assistance: "revealed", masteryEvidence: false };
        const blocks = [...current.blocks, { id: exampleId, type: "example", content: { text: `同类新例题（教学辅助，数学待核，不计独立掌握）\n\n${proposal.problem}`, generatedExample } },
          { id: solutionId, type: "steps", content: { steps: [`完整解答（已揭示，数学待核）\n\n${proposal.workedSolution}`], generatedExample } }];
        const position = Math.max(-1, ...current.blockOrder.map(ref => ref.position)) + 1;
        const blockOrder = [...current.blockOrder, { blockId: exampleId, position, role: "example", blockType: "example" },
          { blockId: solutionId, position: position + 1, role: "teach", blockType: "steps" }];
        await createLibraryRepository(sql).updateDocumentInTx(tx, { workspaceId: scope.workspaceId, jobScope: scope,
          documentId: payload.request.target.documentId, expectedRevisionNumber: payload.request.target.revisionNumber, blocks, reason: operationKey(id) });
        const revision = payload.request.target.revisionNumber + 1, version = payload.request.target.contentVersion + 1;
        await tx`UPDATE opening_teaching_activity_specs SET revision_number=${revision},version=${version},block_order=${tx.json(blockOrder)},verification_status='needs_check',updated_at=now()
          WHERE id=${String(current.row.id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        await tx`UPDATE opening_teaching_units SET current_revision_number=${revision},updated_at=now()
          WHERE id=${String(current.row.teaching_unit_id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        const changed = await tx`UPDATE opening_teaching_activities SET content_version=${version},updated_at=now()
          WHERE id=${payload.request.target.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND content_version=${payload.request.target.contentVersion} RETURNING id`;
        if (!changed.length) throw conflict("例题内容版本冲突。");
        // No prompt exposure is fabricated. The appended example is already revealed teaching, not an issued assessment.
      });
      return read(scope, id);
    },
  };
}
