import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { aiGradingInputSchema, aiGradingStatusSchema, gradeObservationJobPayloadSchema, type AiGradingStatus, type GradeObservationJobPayload, type Scope } from "@aistudy/contracts";
import { learningError, lockLearningOwner, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { isOpeningManualGradingRevision, readOpeningAiGradingContext } from "./opening-ai-grading-context";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import { readOpeningAiGradingLedger } from "./opening-ai-grading-ledger";
import { checkOpeningAutoGradeBudget, readOpeningAutoGradeSkip, type OpeningAutoGradePolicy } from "./opening-auto-grade-policy";
import { openingAnswerInterpretationPriorCostUnresolved } from "./opening-answer-interpretation-ledger";
import { readTeachingQuestionForGrading } from "./opening-teaching-question";
import { readOpeningPinnedTeachingChunks } from "./opening-grading-visual-references";

const kind = "grade-observation";

/** Pre-submit routing hint from the owned immutable question, never client media flags.
 * The observation transaction revalidates the complete context before admission. */
export async function readOpeningAttemptGradingUsesVision(sql: Sql, scope: Scope, attemptId: string): Promise<boolean | null> {
  const [item] = await sql`SELECT v.*,a.source_ids AS attempt_source_ids,a.source_versions AS attempt_source_versions
    FROM opening_learning_attempts a JOIN opening_learning_item_versions v ON v.id=a.item_version_id
      AND v.problem_id=a.problem_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
    WHERE a.id=${attemptId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  if (!item) throw learningError("NOT_FOUND", "找不到这次作答的原题");
  try {
    const teaching = await readTeachingQuestionForGrading(sql as unknown as TransactionSql, scope, item);
    const versions = item.attempt_source_versions as Record<string, number>;
    const refs = teaching?.sourceRefs ?? (item.source_id ? [{ sourceId: String(item.source_id),
      version: versions?.[String(item.source_id)], chunkId: item.chunk_id == null ? null : String(item.chunk_id),
      page: item.physical_page == null ? null : Number(item.physical_page) }] : []);
    const chunks = await readOpeningPinnedTeachingChunks(sql, scope, refs, versions ?? {});
    return chunks.some(chunk => Boolean(chunk.image_object_key) && chunk.page != null);
  } catch (error) {
    // A previously issued question may outlive a referenced chunk. Preserve the
    // answer fact while refusing automatic grading; null must never mean text.
    if ((error as { code?: unknown } | null)?.code === "CONFLICT") return null;
    throw error;
  }
}

export async function readOpeningObservationGradingUsesVision(sql: Sql, scope: Scope, observationId: string): Promise<boolean | null> {
  const [observation] = await sql`SELECT attempt_id FROM opening_learning_observations
    WHERE id=${observationId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!observation?.attempt_id) throw learningError("NOT_FOUND", "找不到这次作答的原题");
  return readOpeningAttemptGradingUsesVision(sql, scope, String(observation.attempt_id));
}
export const openingAiGradingJobKey = (scope: Scope, input: GradeObservationJobPayload) =>
  `ai-grade:${scope.workspaceId}:${input.rootObservationId}:${input.answerRevision}`;

async function publish(tx: TransactionSql, scope: Scope, jobId: string) {
  await tx`INSERT INTO opening_outbox(workspace_id,job_id,topic,payload)
    VALUES(${scope.workspaceId},${jobId},'opening.job.enqueue',${tx.json({ jobId, kind })})`;
}

/** Caller holds the learning history/owner locks. No model or queue transport I/O. */
export async function enqueueOpeningAiGradingInTx(tx: TransactionSql, scope: Scope, raw: GradeObservationJobPayload) {
  const input = gradeObservationJobPayloadSchema.parse(raw);
  const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!workspace) throw learningError("NOT_FOUND", "workspace not found");
  const [created] = await tx`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,privacy_epoch)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${openingAiGradingJobKey(scope, input)},${kind},${tx.json(input)},${workspace.privacy_epoch})
    ON CONFLICT(workspace_id,key) DO NOTHING RETURNING id`;
  if (created) await publish(tx, scope, String(created.id));
}

async function readStatus(tx: TransactionSql, scope: Scope, observationId: string, policy?: OpeningAutoGradePolicy): Promise<AiGradingStatus> {
  const [head] = await tx`SELECT h.*,previous.answer AS previous_answer,COALESCE(root.root_observation_id,root.id) AS root_id,w.privacy_epoch AS current_epoch
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    JOIN opening_learning_observations h ON h.id=COALESCE(root.effective_head_id,root.id)
      AND h.workspace_id=root.workspace_id AND h.owner_user_id=root.owner_user_id
    LEFT JOIN opening_learning_observations previous ON previous.id=h.revises_observation_id
      AND previous.workspace_id=h.workspace_id AND previous.owner_user_id=h.owner_user_id
    JOIN workspaces w ON w.id=h.workspace_id AND w.owner_user_id=h.owner_user_id
    JOIN users u ON u.id=w.owner_user_id AND u.disabled_at IS NULL
    JOIN courses c ON c.id=h.course_id AND c.workspace_id=h.workspace_id AND c.archived_at IS NULL
    WHERE o.id=${observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  if (!head) throw learningError("NOT_FOUND", "找不到这次作答");
  const record = await qualifyObservationRevision(tx, scope, head);
  const input = { observationId: String(head.id), rootObservationId: String(head.root_id), answerRevision: Number(head.answer_revision) };
  const [job] = await tx`SELECT * FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND key=${openingAiGradingJobKey(scope, input)} AND kind=${kind}`;
  const operationId = String(head.grading_operation_id ?? `ai-grade:${scope.workspaceId}:${head.id}`);
  const ledger = await readOpeningAiGradingLedger(tx, scope, operationId);
  const interpretationCostUnresolved=await openingAnswerInterpretationPriorCostUnresolved(tx,scope,String(head.id));
  const usable = record.revisionKind !== "retract" && record.eligibility?.usableForCurrentVersion === "yes";
  const evaluated = Boolean(record.aiEvaluation || record.serverEvaluation);
  const canGrade = usable && !evaluated && !isOpeningManualGradingRevision(head) && Boolean(record.attemptId && record.problemId && record.itemVersionId
    && (record.answer.trim() || head.grading_work_source));
  const matchingJob = job && (job.payload as GradeObservationJobPayload).observationId === head.id;
  const currentJob = matchingJob && Number(job.privacy_epoch) === Number(head.current_epoch);
  const status = interpretationCostUnresolved||ledger === "unknown" || ledger === "in_flight" && (!currentJob || job.state !== "running") ? "unknown_cost"
    : evaluated && usable ? record.outcome === "unverified" ? "needs_manual" : "graded"
      : canGrade && currentJob && job.state === "running" ? "grading"
        : canGrade && currentJob && job.state === "queued" ? "queued" : "needs_manual";
  let autoGradeSkipped: AiGradingStatus["autoGradeSkipped"] = !job && canGrade ? input.answerRevision > 1 ? "answer_changed" as const
    : policy ? await readOpeningAutoGradeSkip(tx, scope, policy) : null : null;
  if (!job && canGrade && ledger === "unsent" && !autoGradeSkipped && policy) {
    const context = await readOpeningAiGradingContext(tx, scope, { observationId: String(head.id) }, { readOnly: true });
    const budget = await checkOpeningAutoGradeBudget(tx, scope, policy, {
      question: context.stem, answer: context.observation.answer, referenceText: context.referenceText,
      misconceptions: context.misconceptions, workSource: context.workSourceMetadata, referenceSources: context.referenceSourceMetadata,
    });
    if (!budget.allowed) autoGradeSkipped = budget.reason === "budget_unavailable" ? "budget_unavailable" : "budget";
  }
  return aiGradingStatusSchema.parse({ rootObservationId: input.rootObservationId, headObservationId: head.id,
    autoGradeSkipped,
    answerRevision: input.answerRevision, jobId: job?.id ?? null, status,
    retryable: !interpretationCostUnresolved&&canGrade && ledger === "unsent" && (!job || matchingJob && ["failed", "cancelled", "outcome_unknown"].includes(String(job.state))),
    workSource: head.grading_work_source ?? null });
}

export function createOpeningAiGradingJobRepository(sql: Sql) {
  return {
    /** Truly read-only: never reserves budget, creates a job, or changes source versions. */
    read(scope: Scope, raw: unknown, policy?: OpeningAutoGradePolicy) {
      const input = aiGradingInputSchema.parse(raw);
      return sql.begin("isolation level repeatable read read only", tx => readStatus(tx, scope, input.observationId, policy)) as Promise<AiGradingStatus>;
    },
    async enqueue(scope: Scope, raw: unknown) {
      const input = aiGradingInputSchema.parse(raw);
      await sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        const status = await readStatus(tx, scope, input.observationId);
        if (status.headObservationId !== input.observationId) throw learningError("CONFLICT", "作答已更正，请刷新后再批改");
        if (input.workSourceId && (status.workSource?.id !== input.workSourceId || status.workSource.version !== input.workSourceVersion
          || status.workSource.physicalPage !== input.physicalPage)) throw learningError("CONFLICT", "请在保存新作答时一并附上照片");
        if (!status.retryable) return;
        // Revalidate the sealed question, source versions, photo and authority at admission.
        const context = await readOpeningAiGradingContext(tx, scope, { observationId: input.observationId });
        if (context.existing) return;
        if (!status.jobId) {
          await enqueueOpeningAiGradingInTx(tx, scope, { observationId: input.observationId,
            rootObservationId: status.rootObservationId, answerRevision: status.answerRevision });
        } else {
          const [job] = await tx`UPDATE opening_jobs SET state='queued',claim_token=NULL,result=NULL,updated_at=now(),
            privacy_epoch=(SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId})
            WHERE id=${status.jobId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND state IN ('failed','cancelled','outcome_unknown') RETURNING id`;
          if (job) await publish(tx, scope, String(job.id));
        }
      });
      return this.read(scope, input);
    },
    /** Run BEFORE generic job recovery. Safe pre-send crashes are requeued;
     * claimed/unknown spend is only inspected, never released or sent again. */
    async recoverExpired(limit = 50) {
      const candidates = await sql`SELECT id,workspace_id,owner_user_id FROM opening_jobs
        WHERE kind=${kind} AND ((state='running' AND updated_at<now()-interval '5 minutes')
          OR state='outcome_unknown' AND updated_at<now()-interval '5 minutes') ORDER BY (state='running') DESC,updated_at LIMIT ${limit}`;
      let recovered = 0;
      for (const candidate of candidates) {
        const changed = await sql.begin(async tx => {
          const scope = { workspaceId: String(candidate.workspace_id), ownerUserId: String(candidate.owner_user_id) };
          const [workspace] = await tx`SELECT w.privacy_epoch,u.disabled_at FROM workspaces w JOIN users u ON u.id=w.owner_user_id
            WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} FOR UPDATE OF w`;
          const [job] = await tx`SELECT * FROM opening_jobs WHERE id=${candidate.id}
            AND ((state='running' AND updated_at<now()-interval '5 minutes') OR state='outcome_unknown') FOR UPDATE`;
          if (!workspace || !job) return false;
          const payload = gradeObservationJobPayloadSchema.parse(job.payload);
          const [head] = await tx`SELECT h.* FROM opening_learning_observations root
            JOIN opening_learning_observations h ON h.id=COALESCE(root.effective_head_id,root.id)
            WHERE root.id=${payload.rootObservationId} AND root.workspace_id=${scope.workspaceId} AND root.owner_user_id=${scope.ownerUserId}`;
          const [target] = await tx`SELECT grading_operation_id FROM opening_learning_observations
            WHERE id=${payload.observationId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
          const ledger = await readOpeningAiGradingLedger(tx, scope, String(target?.grading_operation_id ?? `ai-grade:${scope.workspaceId}:${payload.observationId}`));
          const matchingResult = head?.ai_evaluation && (head.submitted_intent as { aiGrading?: { input?: { observationId?: string } } })?.aiGrading?.input?.observationId === payload.observationId;
          const obsolete = workspace.disabled_at != null || !head || Number(head.answer_revision) !== payload.answerRevision || head.revision_kind === "retract"
            || Number(workspace.privacy_epoch) !== Number(job.privacy_epoch)
            || head.id !== payload.observationId && !matchingResult;
          const saved = !obsolete && matchingResult;
          const state = saved ? "succeeded" : ledger === "unknown" || ledger === "in_flight" ? "outcome_unknown"
            : obsolete || ledger !== "unsent" ? "failed" : "queued";
          if (job.state === state) {
            // Rotate unresolved ledger reads so a backlog cannot starve recovery.
            await tx`UPDATE opening_jobs SET updated_at=now() WHERE id=${job.id}`;
            return false;
          }
          await tx`UPDATE opening_jobs SET state=${state},claim_token=NULL,updated_at=now(),
            result=${tx.json(saved ? { observationId: head.id } : { error: state === "queued" ? "recovered before send" : "grading requires manual review" })} WHERE id=${job.id}`;
          if (state === "queued") await publish(tx, scope, String(job.id));
          return true;
        });
        if (changed) recovered += 1;
      }
      return recovered;
    },
  };
}
