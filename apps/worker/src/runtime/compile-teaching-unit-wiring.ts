import { assembleTeachingEvidencePack, buildModelTeachingInput, compileModelTeaching, estimateUsage, usageFromOutput, OpeningProviderError } from "@aistudy/ai";
import { resolveTutorModel } from "./tutor-model";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
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
 * handler (tests exercise the same production wiring,
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
  // Production always resolves a real model when the compiler is enabled.
  // Disabled or unavailable models fail honestly; no stub is published.
  // V2-09: optional post-publish validation when OPENING_TEACHING_VALIDATION_ENABLED; off → leave needs_check.
  const teachingCompilerOn = isTeachingCompilerEnabled();
  const teachingValidationOn = isTeachingValidationEnabled();
  return {
    budget,
    provider: null,
    prepareModelCall: async (scope, payload) => {
      if (!teachingCompilerOn) throw new OpeningProviderError("PROVIDER_DISABLED", "teaching compiler is disabled");
      const activity = await teachingActivities.get(scope, payload.activityId);
      if (!activity) throw new Error("teaching activity not found");
      const sourceIds = payload.sourceIds ?? [];
      const chunks = await shared.chunks.listForSources(scope, sourceIds);
      const pack = assembleTeachingEvidencePack({
        chunks, query: activity.intentSummary, maxCharacters: 12_000,
        allowlistSourceIds: sourceIds,
      });
      if (sourceIds.length && !pack.chunks.length)
        throw new OpeningProviderError("PROVIDER_MEDIA_UNSUPPORTED", "authorized material has no readable text; use the vision tutor or review parsing");
      const model = await resolveTutorModel(sql, scope, "explain", { answerStyle: false });
      const input = buildModelTeachingInput(activity.intentSummary, pack.chunks);
      const reservedCents = Math.max(1, estimateUsage({
        inputTokens: Buffer.byteLength(JSON.stringify(input), "utf8") + 4096,
        outputTokens: input.maxOutputTokens, estimated: true,
      }, model));
      return {
        input, provider: model.provider, modelSnapshot: model.modelSnapshot, reservedCents,
        actualCents: (output) => estimateUsage(usageFromOutput(output), model),
        buildPublishInput: async (ownedScope, body, output) => {
          if (!output || !body.teachingUnitId) throw new Error("model teaching result or unit missing");
          const compiled = compileModelTeaching({
            text: output.text, chunks: pack.chunks,
            activityId: body.activityId, teachingUnitId: body.teachingUnitId,
            expectedContentVersion: body.expectedContentVersion,
            revisionNumber: 1, newId: randomUUID,
          });
          const written = await teachingContent.writeUnitBlocks(ownedScope, body.teachingUnitId, compiled.blocks);
          return { ...compiled.publishInput, revisionNumber: written.revisionNumber };
        },
      };
    },
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
      const activity = await teachingActivities.get(scope, payload.activityId);
      const unit = await teachingContent.createUnit(scope, {
        title: activity?.intentSummary.slice(0, 160) || `Teaching draft ${payload.activityId.slice(0, 8)}`,
        blocks: [{ id: randomUUID(), type: "meta", content: { text: "draft" } }],
      });
      return unit.id;
    },
    buildPublishInput: teachingCompilerOn
      ? async (scope, payload, providerOutput) => {
          const activity = await teachingActivities.get(scope, payload.activityId);
          let revisionNumber: number | null = null;
          const build = createTeachingCompilerPublishInput({
            loadChunks: (ownedScope, sourceIds) => chunks.listForSources(ownedScope as Scope, sourceIds),
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
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
