import type { Sql } from "postgres";
import {
  createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository,
  type OpeningBudgetRepository,
  type createOpeningPrivacyRepository,
  type createOpeningSourceChunksRepository,
} from "@aistudy/database";
import {
  createTeachingCompilerPublishInput,
  createTeachingValidationAfterPublish,
  isTeachingCompilerEnabled,
  isTeachingValidationEnabled,
  type CompileTeachingUnitDeps,
} from "../jobs/compile-teaching-unit";

/**
 * Production dependency construction for the compile-teaching-unit worker
 * handler (moved verbatim from index.ts so tests exercise the real wiring,
 * including the PR-D resultRef replay loader).
 */
export function createCompileTeachingUnitWorkerDeps(
  sql: Sql,
  shared: {
    budget: OpeningBudgetRepository;
    chunks: ReturnType<typeof createOpeningSourceChunksRepository>;
    privacy: ReturnType<typeof createOpeningPrivacyRepository>;
  },
): CompileTeachingUnitDeps {
  const { budget, chunks, privacy: privacyRepo } = shared;
  const teachingActivities = createOpeningTeachingActivitiesRepository(sql);
  const teachingContent = createOpeningTeachingContentRepository(sql);
  // V2-08: teaching-compiler via buildPublishInput when OPENING_TEACHING_COMPILER_ENABLED;
  // otherwise keep V2-07 stub publish (empty blockOrder + extras.stub). Budget/cancel/epoch fences unchanged.
  // V2-09: optional post-publish validation when OPENING_TEACHING_VALIDATION_ENABLED; off → leave needs_check.
  const teachingCompilerOn = isTeachingCompilerEnabled();
  const teachingValidationOn = isTeachingValidationEnabled();
  return {
    budget,
    provider: {
      complete: async () => ({
        text: JSON.stringify(
          teachingCompilerOn
            ? { compiler: "teaching-compiler" }
            : { stub: true },
        ),
        citedChunkIds: [],
        requestId: null,
        candidates: [],
        inputTokens: 1,
        outputTokens: 1,
      }),
    },
    reservedCents: 100,
    setGenerateStatus: (scope, activityId, status, options) =>
      teachingActivities.setGenerateStatus(scope, activityId, status, options),
    publishActivitySpec: (scope, input) => teachingContent.publishActivitySpec(scope, input),
    loadReplayedResult: async (scope, resultRef) => {
      const match = /^teaching_activity:(.+)$/.exec(resultRef);
      if (!match) return null;
      const activity = await teachingActivities.get(scope, match[1]!);
      return activity ? { activityId: activity.id, generateStatus: activity.generateStatus } : null;
    },
    getJobState: async (jobId) => {
      const rows = await sql<{ state: string }[]>`
        SELECT state FROM opening_jobs WHERE id = ${jobId} LIMIT 1`;
      return rows[0]?.state ?? null;
    },
    ensureTeachingUnitId: async (scope, payload) => {
      if (payload.teachingUnitId) return payload.teachingUnitId;
      const unit = await teachingContent.createUnit(scope, {
        title: `Teaching draft ${payload.activityId.slice(0, 8)}`,
        blocks: [],
      });
      return unit.id;
    },
    buildPublishInput: teachingCompilerOn
      ? createTeachingCompilerPublishInput({
          loadChunks: async (scope, sourceIds) => {
            const s = scope as { workspaceId: string; ownerUserId: string };
            return chunks.listForSources(s, sourceIds);
          },
        })
      : undefined,
    verifyAfterPublish: teachingValidationOn
      ? createTeachingValidationAfterPublish({
          loadChunks: async (scope: { workspaceId: string; ownerUserId: string }, sourceIds: string[]) => {
            return chunks.listForSources(scope, sourceIds);
          },
        })
      : undefined,
    privacy: {
      getWorkspaceEpoch: (scope) => privacyRepo.getWorkspaceEpoch(scope),
      listExcludedSourceIds: (scope) => privacyRepo.listExcludedSourceIds(scope),
    },
  };
}
