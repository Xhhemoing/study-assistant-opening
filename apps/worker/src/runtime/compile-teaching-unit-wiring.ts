import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import {
  createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository,
  readOpeningTeachingCompilerFocus,
  readOpeningTeachingParentBudget,
  type OpeningBudgetRepository,
  type createOpeningPrivacyRepository,
  type createOpeningSourceChunksRepository,
} from "@aistudy/database";
import { createCompilerProviderInput } from "@aistudy/ai";
import { createDbModelGateway, scopeBudget } from "./model-gateway";
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
  // Real lessons always use the model gateway. An explicit off switch fails the job
  // before budget/content writes instead of publishing an empty placeholder lesson.
  // V2-09: optional post-publish validation when OPENING_TEACHING_VALIDATION_ENABLED; off → leave needs_check.
  const teachingCompilerOn = isTeachingCompilerEnabled();
  const teachingValidationOn = isTeachingValidationEnabled();
  const models = createDbModelGateway(sql);
  const loadChunks = (ownedScope: unknown, sourceIds: string[]) => chunks.listForSources(ownedScope as Scope, sourceIds);
  const modelPath: Pick<CompileTeachingUnitDeps, "callModel" | "buildProviderInput"> = teachingCompilerOn
    ? {
        callModel: (scope, input, options) =>
          models.call(scope, "teaching.compile", { budget: scopeBudget(budget, scope), input, ...options }),
        buildProviderInput: async (scope, payload) => {
          const activity = await teachingActivities.get(scope, payload.activityId);
          const focus = await readOpeningTeachingCompilerFocus(sql, scope, payload.activityId);
          return createCompilerProviderInput({
            loadChunks,
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
            ...focus,
          })(scope, payload);
        },
      }
    : {};
  return {
    budget,
    resolveParentBudget: (scope, payload) => readOpeningTeachingParentBudget(sql, scope, payload.activityId),
    ...modelPath,
    enabled: teachingCompilerOn,
    provider: null,
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
      // A library document needs at least one block; the compiled blocks
      // replace this placeholder as the next revision before publish.
      const unit = await teachingContent.createUnit(scope, {
        title: `Teaching draft ${payload.activityId.slice(0, 8)}`,
        blocks: [{ id: randomUUID(), type: "meta", content: { text: "draft" } }],
      });
      return unit.id;
    },
    buildPublishInput: teachingCompilerOn
      ? async (scope, payload, providerOutput) => {
          const activity = await teachingActivities.get(scope, payload.activityId);
          let revisionNumber: number | null = null;
          const build = createTeachingCompilerPublishInput({
            loadChunks,
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
            // A real model wrote this activity: never fall back to template filler.
            requireModelOutput: true,
            // Preserve the activity's original prompt boundary even if current
            // evidence/graph revalidation removed its prelude from model input.
            learnerFocus: activity?.learnerFocus,
            writeLibraryBlocks: async (blocks) => {
              const written = await teachingContent.writeUnitBlocks(scope, payload.teachingUnitId!, blocks);
              revisionNumber = written.revisionNumber;
            },
          });
          const publishInput = await build(scope, payload, providerOutput);
          if (revisionNumber == null) throw new Error("compiled blocks were not written to the unit document");
          // Pin the revision holding the compiled bodies so client-init reads them.
          return { ...publishInput, revisionNumber };
        }
      : undefined,
    verifyAfterPublish: teachingValidationOn
      ? (scope, input) => {
          // Check against the chunks the compiler pinned, not a fresh budget-filled
          // selection that may leave them out and fail source identity.
          const pinned = new Set(
            (input.publishInput.sourceRefs ?? []).flatMap((ref) => (ref.chunkId ? [ref.chunkId] : [])),
          );
          return createTeachingValidationAfterPublish({
            loadChunks: async (ownedScope, sourceIds) => {
              const rows = await chunks.listForSources(ownedScope, sourceIds);
              return pinned.size ? rows.filter((row) => pinned.has(row.id)) : rows;
            },
            // Without the published bodies the claim layer has nothing to check
            // and can never pass, so the activity would stay needs_check forever.
            loadBlocks: async (ownedScope, publishInput) => {
              const unit = await teachingContent.getUnit(ownedScope, publishInput.teachingUnitId);
              if (!unit) return [];
              const revision = await teachingContent.readRevision(ownedScope, unit.documentId, publishInput.revisionNumber);
              const roles = new Map(publishInput.blockOrder.map((ref) => [ref.blockId, ref.role]));
              return revision.blocks
                .filter((block) => roles.has(block.id))
                .map((block) => ({ id: block.id, type: block.type, role: roles.get(block.id)!, content: block.content }));
            },
          })(scope, input);
        }
      : undefined,
    privacy: {
      getWorkspaceEpoch: (scope) => privacyRepo.getWorkspaceEpoch(scope),
      listExcludedSourceIds: (scope) => privacyRepo.listExcludedSourceIds(scope),
    },
  };
}
