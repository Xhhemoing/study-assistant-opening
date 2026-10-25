import {
  learningResumeSchema,
  teachingActivityStatusUpdateInputSchema,
  teachingCheckpointSaveInputSchema,
  teachingCheckpointSaveResultSchema,
  teachingActivitySummarySchema,
  uuidSchema,
  type LearningResume,
  type Scope,
  type TeachingActivity,
  type TeachingCheckpointSaveResult,
} from "@aistudy/contracts";
import {
  assertOwnedActivity,
  createOpeningLearningAttemptRepository,
  createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository,
  listDeliveredHelpByActivity,
  listObservationHeadsByActivity,
  probeLearningSourcesAvailability,
  reconcileTeachingGenerate,
  sanitizeCheckpointForRestore,
} from "@aistudy/database";
import { loadOpeningJobStaleConfig } from "@aistudy/config";
import {
  assertResumeIndependentOfSummary,
  deriveOpenProblems,
  extractThoughtTrain,
  listContinuableActions,
  mapAttemptRowsToSummaries,
  mapGenerateStatusToJobGate,
  probeMaterialsAvailability,
  readDraftsFromCheckpoint,
  readInteractionParams,
  readOpenProblemIds,
  resumeSummarySkipped,
  summarizeTeachingBlockCoverage,
} from "@aistudy/domain";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

function mapError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: string }).code);
    const message = error instanceof Error ? error.message : "teaching resume error";
    if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", message, 404);
    if (code === "VALIDATION") throw new ApiError("VALIDATION", message, 400);
    if (code === "CONFLICT") throw new ApiError("CONFLICT", message, 409);
  }
  throw error;
}

/**
 * V2-14 LearningResume assembler + checkpoint/status facade.
 * Sibling of teaching-content / command services — never calls course summarize.
 */
export function createOpeningTeachingResumeService(
  sql: Sql,
  options: { generateStaleMs?: number } = {},
) {
  const generateStaleMs = options.generateStaleMs ?? loadOpeningJobStaleConfig().teachingGenerateStaleMs;
  const activities = createOpeningTeachingActivitiesRepository(sql);
  const content = createOpeningTeachingContentRepository(sql);
  const attemptsRepo = createOpeningLearningAttemptRepository(sql);

  return {
    async getSummary(scope: Scope, activityIdRaw: string) {
      const activityId = uuidSchema.parse(activityIdRaw);
      try {
        const activity = await assertOwnedActivity(sql, scope, activityId);
        const [init, facts] = await Promise.all([
          content.getClientInit(scope, activityId),
          activities.readSummaryFacts(scope, activityId),
        ]);
        const taskId = uuidSchema.safeParse(facts.taskId);
        return teachingActivitySummarySchema.parse({
          ...summarizeTeachingBlockCoverage(init?.blockOrder ?? [], activity.checkpointJson ?? {}),
          attempts: facts.attempts,
          openQuestions: facts.openQuestions,
          taskId: taskId.success ? taskId.data : null,
        });
      } catch (error) { mapError(error); }
    },
    async getResume(scope: Scope, activityIdRaw: string): Promise<LearningResume> {
      const activityId = uuidSchema.parse(activityIdRaw);
      try {
        assertResumeIndependentOfSummary();
        let activity = await assertOwnedActivity(sql, scope, activityId);
        if (activity.generateStatus === "queued" || activity.generateStatus === "generating") {
          // A dead compile job would otherwise keep jobGate=in_flight (正在准备讲解) forever;
          // a terminal status lets the existing UI offer 重新生成. Never blocks resume.
          try {
            const reconciled = await reconcileTeachingGenerate(sql, scope, activityId, { staleMs: generateStaleMs });
            if (reconciled.changed) activity = await assertOwnedActivity(sql, scope, activityId);
          } catch {
            // Reconciliation is best effort; the worker sweep retries it.
          }
        }

        let clientInit = null as Awaited<ReturnType<typeof content.getClientInit>>;
        try {
          clientInit = await content.getClientInit(scope, activityId);
        } catch {
          clientInit = null;
        }

        const rawCheckpoint =
          (activity.checkpointJson as Record<string, unknown> | undefined) ?? {};
        const sanitized = sanitizeCheckpointForRestore(rawCheckpoint);
        const thoughtTrain = extractThoughtTrain(sanitized);
        const drafts = readDraftsFromCheckpoint(sanitized);
        const interactionParams = readInteractionParams(sanitized);
        const checkpointOpenProblemIds = readOpenProblemIds(sanitized);

        const attemptRows = await attemptsRepo.listByActivity(scope, activityId, 100);
        const actualAttempts = mapAttemptRowsToSummaries(
          attemptRows.map((row) => ({
            attemptId: row.id,
            problemId: row.problemId,
            itemVersionId: row.itemVersionId,
            submittedAt: row.submittedAt,
            outcome: row.outcome,
            assistance: row.assistance,
          })),
        );

        const helpRows = await listDeliveredHelpByActivity(sql, scope, activityId, 100);
        const helpDelivered = helpRows.map((h) => ({
          id: h.id,
          kind: h.kind,
          level: h.level,
          problemId: h.problemId,
          deliveredAt: h.deliveredAt ?? undefined,
        }));

        const observationHeads = await listObservationHeadsByActivity(
          sql,
          scope,
          activityId,
          100,
        );
        const openProblems = deriveOpenProblems({
          attempts: attemptRows.map((row) => ({
            attemptId: row.id,
            problemId: row.problemId,
            itemVersionId: row.itemVersionId,
            submittedAt: row.submittedAt,
            outcome: row.outcome,
          })),
          observationHeads,
          checkpointOpenProblemIds,
        });

        const probe = await probeLearningSourcesAvailability(
          sql,
          scope,
          activity.sourceIds,
        );
        const materialsGate = probeMaterialsAvailability(
          activity.sourceIds,
          probe.availableIds,
        );
        const jobGate = mapGenerateStatusToJobGate(activity.generateStatus);
        const continuableActions = listContinuableActions({
          jobGate,
          materials: materialsGate.materials,
          branchStack: thoughtTrain.branchStack,
          drafts,
          status: activity.status,
          hasClientInit: clientInit != null,
        });

        // Optional summary field never blocks resume — always skipped (no AI call).
        const summary = resumeSummarySkipped();

        const package_ = {
          activityId: activity.id,
          status: activity.status,
          generateStatus: activity.generateStatus,
          contentVersion: activity.contentVersion,
          pathVersion: activity.pathVersion,
          clientInit,
          thoughtTrain,
          drafts,
          interactionParams,
          actualAttempts,
          helpDelivered,
          openProblems,
          gates: {
            permission: "owned" as const,
            materials: materialsGate.materials,
            unavailableSourceIds: materialsGate.unavailableSourceIds,
            job: jobGate,
          },
          continuableActions,
          summary,
        };
        return learningResumeSchema.parse(package_);
      } catch (error) {
        mapError(error);
      }
    },

    async saveCheckpoint(
      scope: Scope,
      activityIdRaw: string,
      raw: unknown,
    ): Promise<TeachingCheckpointSaveResult> {
      const activityId = uuidSchema.parse(activityIdRaw);
      const input = teachingCheckpointSaveInputSchema.parse(raw);
      try {
        assertResumeIndependentOfSummary();
        await assertOwnedActivity(sql, scope, activityId);
        const result = await content.saveCheckpoint(scope, activityId, input);
        return teachingCheckpointSaveResultSchema.parse(result);
      } catch (error) {
        mapError(error);
      }
    },

    async setStatus(
      scope: Scope,
      activityIdRaw: string,
      raw: unknown,
    ): Promise<TeachingActivity> {
      const activityId = uuidSchema.parse(activityIdRaw);
      const input = teachingActivityStatusUpdateInputSchema.parse(raw);
      try {
        return await activities.setStatus(scope, activityId, input);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningTeachingResumeService = ReturnType<
  typeof createOpeningTeachingResumeService
>;
