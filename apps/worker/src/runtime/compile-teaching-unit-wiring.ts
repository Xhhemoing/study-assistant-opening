import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readStoredTeachingOutline } from "./teaching-outline";
import { checkTeachingFormula } from "./teaching-formula-check";
import type { Sql } from "postgres";
import { type Scope, type ProviderOutput, type OpeningModelSnapshot, type ActivitySpecPublishInput } from "@aistudy/contracts";
import {
  createLibraryRepository,
  createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository,
  createOpeningCourseReadySourcesRepository,
  readOpeningTeachingCompilerFocus,
  readOpeningTeachingParentBudget,
  assertOpeningCourseRouteReady,
  readOpeningCourseRouteEvidenceRefs,
  admitOpeningReservedCandidate,
  type OpeningBudgetRepository,
  type createOpeningPrivacyRepository,
  type createOpeningSourceChunksRepository,
} from "@aistudy/database";
// Repository helper shares the authoritative saved question/key projection (not a new provider channel).
import { resolveOpeningTeachingBlindSolveQuestion } from "../../../../packages/database/src/repositories/opening-teaching-question-evaluation";
import { readCourseRequirements } from "../../../../packages/database/src/repositories/opening-course-route-read";
import { createCompilerProviderInput, parseModelJson, solveTeachingBlind, type TeachingBlindSolveReceipt } from "@aistudy/ai";
import { admitReservedQuestionOutput, buildReservedQuestionProviderInput, type ReservedQuestionProducerInput } from "../../../../packages/ai/src/opening/reserved-question-producer";
import { createDbModelGateway, scopeBudget, teachingBlindSolveConfig } from "./model-gateway";
import { createOpeningMaterialRetriever } from "./material-retrieval";
import { createSourcePageImages, openingPageStorage } from "./source-page-images";
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
    pageImages?: ReturnType<typeof createSourcePageImages>;
  },
): CompileTeachingUnitDeps {
  const { budget, chunks, privacy: privacyRepo } = shared;
  const teachingActivities = createOpeningTeachingActivitiesRepository(sql);
  const teachingContent = createOpeningTeachingContentRepository(sql);
  const library = createLibraryRepository(sql);
  const purposes = createOpeningCourseReadySourcesRepository(sql);
  type PurposePin = Awaited<ReturnType<typeof purposes.readSourcePurposePin>>;
  type PinnedGeneration = { pin: PurposePin; assertRetrievalCurrent?: () => Promise<void> };
  const generationPins = new WeakMap<object, PinnedGeneration>();
  type StagedPublication = {
    pinned: PinnedGeneration;
    compiled: Parameters<typeof teachingContent.publishCompiledActivity>[2];
    input: ActivitySpecPublishInput;
  };
  const publicationPins = new WeakMap<object, StagedPublication>();
  // Handler metadata promotion shallow-copies input but retains its blockOrder.
  // Bind that server-created graph as well; never key authority by an activity id.
  const publicationGraphPins = new WeakMap<object, StagedPublication>();
  const stagedPublication = (input: ActivitySpecPublishInput) => {
    const staged = publicationPins.get(input) ?? publicationGraphPins.get(input.blockOrder);
    if (!staged || !isDeepStrictEqual({ ...input, expectedVersion: staged.input.expectedVersion,
      verificationStatus: staged.input.verificationStatus }, staged.input)) {
      throw Object.assign(new Error("compiler publication graph missing or changed"), { code: "CONFLICT" });
    }
    return staged;
  };
  const assertGenerationCurrent = async (scope: Scope, pinned: PinnedGeneration) => {
    await purposes.assertSourcePurposePin(scope, pinned.pin);
    await pinned.assertRetrievalCurrent?.();
  };
  // Real lessons always use the model gateway. An explicit off switch fails the job
  // before budget/content writes instead of publishing an empty placeholder lesson.
  // V2-09: optional post-publish validation when OPENING_TEACHING_VALIDATION_ENABLED; off → leave needs_check.
  const teachingCompilerOn = isTeachingCompilerEnabled();
  const teachingValidationOn = isTeachingValidationEnabled();
  const models = createDbModelGateway(sql);
  const generatorSnapshots = new WeakMap<ProviderOutput, OpeningModelSnapshot>();
  const reservedContexts = new WeakMap<object, ReservedQuestionProducerInput>();
  const retrieveContext = createOpeningMaterialRetriever(sql, budget);
  const pageImages = shared.pageImages ?? createSourcePageImages(sql, openingPageStorage());
  const loadChunks = (ownedScope: unknown, sourceIds: string[]) => chunks.listForSources(ownedScope as Scope, sourceIds);
  const modelPath: Pick<CompileTeachingUnitDeps, "callModel" | "buildProviderInput"> = teachingCompilerOn
    ? {
        callModel: async (scope, input, options) => {
          let snapshot: OpeningModelSnapshot | undefined;
          const output = await models.call(scope, input.imageParts.length ? "teaching.compile-visual" : "teaching.compile", { budget: scopeBudget(budget, scope), input, ...options,
            onModel: model => { snapshot = model.modelSnapshot; },
            beforeSend: async () => {
              const pinned = generationPins.get(input);
              if (!pinned) throw Object.assign(new Error("compiler source purpose pin missing"), { code: "CONFLICT" });
              await assertGenerationCurrent(scope, pinned);
              await assertOpeningCourseRouteReady(sql, scope, options.resultRef.replace(/^teaching_activity:/, ""));
              await options.beforeSend?.();
            } });
          if (snapshot) generatorSnapshots.set(output, snapshot);
          const pinned = reservedContexts.get(input);
          if (pinned) {
            const generation = generationPins.get(input);
            if (!generation) throw Object.assign(new Error("original private generation purpose pin missing"), { code: "CONFLICT" });
            const activityId = options.resultRef.replace(/^teaching_activity:/, "");
            const assertPrivateCurrent = async () => {
              const jobId = options.operationId.replace(/^compile-teaching-unit:/, "");
              const [job] = await sql`SELECT state FROM opening_jobs WHERE id=${jobId} AND workspace_id=${scope.workspaceId}
                AND owner_user_id=${scope.ownerUserId}`;
              if (job?.state !== "running") throw new Error("private generation job no longer running");
              await assertGenerationCurrent(scope, generation);
              await assertOpeningCourseRouteReady(sql, scope, activityId);
              await options.beforeSend?.();
            };
            await models.call(scope, "teaching.compile", {
                  budget: scopeBudget(budget, scope), input: buildReservedQuestionProviderInput(pinned),
                  operationId: `${options.operationId}:reserved`, resultRef: `reserved-generation:${activityId}`,
                  parentBudget: options.parentBudget,
                  beforeSend: assertPrivateCurrent,
                  // Admission precedes settlement. Nothing persists the raw response
                  // in a job, public config, replay body or library revision.
                  persistResult: async privateOutput => {
                    await admitReservedQuestionOutput(pinned, privateOutput.text, async candidate => {
                      await assertPrivateCurrent();
                      const { text, interaction, answer, scope: ownedScope, ...context } = candidate;
                      return admitOpeningReservedCandidate(sql, ownedScope, activityId, context, { text, interaction, answer }, {
                        assertPinnedContext: tx => purposes.assertSourcePurposePin(scope, generation.pin, tx),
                      });
                    });
                  },
            });
          }
          return output;
        },
        buildProviderInput: async (scope, payload, options) => {
          const pin = await purposes.readSourcePurposePin(scope, {
            activityId: payload.activityId, sourceIds: payload.sourceIds, materialUse: "teaching",
          });
          const pinned: PinnedGeneration = { pin };
          const routeEvidence = await readOpeningCourseRouteEvidenceRefs(sql, scope, payload.activityId);
          const scopedLoadChunks = async (ownedScope: unknown, sourceIds: string[]) => {
            const rows = await loadChunks(ownedScope, sourceIds);
            return routeEvidence ? rows.filter(row => routeEvidence.chunkIds.includes(row.id)) : rows;
          };
          const activity = await teachingActivities.get(scope, payload.activityId);
          const focus = await readOpeningTeachingCompilerFocus(sql, scope, payload.activityId);
          const spec = await teachingContent.getActivitySpec(scope, payload.activityId);
          const outline = readStoredTeachingOutline(spec?.generationConfig.extras?.outline, payload.activityId, payload.sourceIds ?? []);
          const input = await createCompilerProviderInput({
            loadChunks: scopedLoadChunks,
            retrieveContext: async (ownedScope, request) => {
              await assertGenerationCurrent(scope, pinned);
              const result = await retrieveContext(ownedScope, { ...request,
                courseContext: { courseId: pin.courseId, materialUse: pin.materialUse } });
              pinned.assertRetrievalCurrent = result.assertCurrent;
              await assertGenerationCurrent(scope, pinned);
              return result;
            },
            loadPageImages: (ownedScope, input) => pageImages(ownedScope as Scope, input),
            readOutline: () => outline,
            parentBudget: options?.parentBudget,
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
            ...focus,
          })(scope, payload);
          generationPins.set(input, pinned);
          if (activity?.routeManaged && activity.courseId) {
            const route = await assertOpeningCourseRouteReady(sql, scope, payload.activityId);
            const requirement = route && (await readCourseRequirements(sql, scope, activity.courseId)).find(row => row.id === route.requirementId);
            const sourceVersions = Object.fromEntries(requirement?.sourceRefs.map(ref => [ref.sourceId, ref.sourceVersion]) ?? []);
            if (requirement?.requirementKey === "arithmetic" && input.chunks.length && !input.chunks.some(chunk => chunk.imageObjectKey)) reservedContexts.set(input, {
              scope, courseId: activity.courseId, requirementId: requirement.id,
              requirementRevision: requirement.revision, sourceVersions,
              requirementText: "Generate a pure rational arithmetic expression, with all conditions in text and no units or figures.",
              evidence: { chunks: input.chunks },
            });
          }
          return input;
        },
      }
    : {};
  // Per-result, one-use bookkeeping keeps handler preflight for custom builders
  // without repeating the production builder's check (including wrapped builders).
  // Contract: the object the production builder returns must not be mutated in
  // place before it reaches the handler. The skip keys on object identity, so an
  // in-place edit (e.g. to sourceRefs) would bypass the handler preflight for the
  // edited refs; the authoritative check inside the publish transaction still
  // rejects them. Wrappers that change the input must return a new object.
  const preflightedInputs = new WeakSet<object>();
  return {
    budget,
    resolveParentBudget: (scope, payload) => readOpeningTeachingParentBudget(sql, scope, payload.activityId),
    ...modelPath,
    enabled: teachingCompilerOn,
    provider: null,
    reservedCents: 100,
    setGenerateStatus: (scope, activityId, status, options) =>
      teachingActivities.setGenerateStatus(scope, activityId, status, options),
    validateSourceRefs: (scope, input) => preflightedInputs.delete(input)
      ? Promise.resolve()
      : teachingContent.validateActivitySourceRefs(scope, input),
    publishActivitySpec: (scope, input) => {
      const staged = stagedPublication(input);
      return teachingContent.publishCompiledActivity(scope, input, staged.compiled,
        tx => purposes.assertSourcePurposePin(scope, staged.pinned.pin, tx));
    },
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
      // replace this placeholder atomically with publication as the next revision.
      // The unit is a learner-visible library document (search, notes, citations),
      // so title it after what the learner asked to study, never an internal label.
      const activity = await teachingActivities.get(scope, payload.activityId);
      const title = activity?.intentSummary?.split("\n")[0]?.trim().slice(0, 120) || "学习讲义";
      const unit = await teachingContent.createUnit(scope, {
        title,
        blocks: [{ id: randomUUID(), type: "meta", content: { text: "draft" } }],
      });
      return unit.id;
    },
    buildPublishInput: teachingCompilerOn
      ? async (scope, payload, providerOutput, providerInput) => {
          const pinned = providerInput ? generationPins.get(providerInput) : undefined;
          if (!pinned) throw Object.assign(new Error("original compiler purpose pin missing"), { code: "CONFLICT" });
          await assertGenerationCurrent(scope, pinned);
          const routeEvidence = await readOpeningCourseRouteEvidenceRefs(sql, scope, payload.activityId);
          const scopedLoadChunks = async (ownedScope: unknown, sourceIds: string[]) => {
            const rows = await loadChunks(ownedScope, sourceIds);
            return routeEvidence ? rows.filter(row => routeEvidence.chunkIds.includes(row.id)) : rows;
          };
          const activity = await teachingActivities.get(scope, payload.activityId);
          const spec = await teachingContent.getActivitySpec(scope, payload.activityId);
          const outline = readStoredTeachingOutline(spec?.generationConfig.extras?.outline, payload.activityId, payload.sourceIds ?? []);
          let compiledBlocks: Parameters<typeof teachingContent.writeUnitBlocks>[2] | null = null;
          const build = createTeachingCompilerPublishInput({
            loadChunks: scopedLoadChunks,
            evidenceChunks: providerInput?.chunks,
            readOutline: () => outline,
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
            // A real model wrote this activity: never fall back to template filler.
            requireModelOutput: true,
            requireMaterialCitations: activity?.routeManaged === true,
            // Preserve the activity's original prompt boundary even if current
            // evidence/graph revalidation removed its prelude from model input.
            learnerFocus: activity?.learnerFocus,
            writeLibraryBlocks: async (blocks) => { compiledBlocks = blocks; },
          });
          // Private output has a separate provider call and may never piggyback
          // on the public compiler response, even if the model ignores instructions.
          if (providerOutput) {
            const raw = parseModelJson(providerOutput.text);
            if (raw && typeof raw === "object" && "reservedQuestions" in raw)
              throw new Error("private reserved output is forbidden in public compile response");
          }
          const publishInput = await build(scope, payload, providerOutput);
          if (compiledBlocks == null) throw new Error("compiled blocks were not built");
          // Fail before saving model bodies, even when post-publish validation is off.
          await teachingContent.validateActivitySourceRefs(scope, publishInput);
          if (pinned) await assertGenerationCurrent(scope, pinned);
          const unit = await teachingContent.getUnit(scope, payload.teachingUnitId!);
          if (!unit) throw new Error("compiled teaching unit missing");
          const document = await library.getDocument({ workspaceId: scope.workspaceId, documentId: unit.documentId });
          // Only predict the number here. Final publication proves the original CAS;
          // no compiled body reaches ordinary library readers before that commit.
          const result: ActivitySpecPublishInput = JSON.parse(JSON.stringify({
            ...publishInput, revisionNumber: document.currentRevisionNumber + 1,
          }));
          const staged: StagedPublication = { pinned, input: structuredClone(result), compiled: {
            // Match the library JSON persistence representation (optional undefined
            // fields are absent), while retaining every compiled body and answer.
            blocks: JSON.parse(JSON.stringify((compiledBlocks as Parameters<typeof teachingContent.writeUnitBlocks>[2])
              .map(({ id, type, content }) => ({ id, type, content })))),
            expectedDocumentRevision: document.currentRevisionNumber, revisionId: randomUUID(),
          } };
          preflightedInputs.add(result);
          publicationPins.set(result, staged);
          publicationGraphPins.set(result.blockOrder, staged);
          return result;
        }
      : undefined,
    persistBlindSolveReceipts: async (scope, job, receipts, beforePersist) => {
      await beforePersist();
      const rows = await sql`UPDATE opening_jobs SET result=jsonb_set(COALESCE(result,'{}'::jsonb),
        ARRAY['teachingBlindSolveReceipts'], ${sql.json(Object.fromEntries(receipts.map(receipt => [receipt.identity.blockId, receipt])) as never)})
        WHERE id=${job.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND state='running' AND privacy_epoch=${job.privacyEpoch}
          AND claim_token IS NOT DISTINCT FROM ${job.claimToken ?? null}::uuid RETURNING id`;
      if (!rows.length) throw new Error("blind solve job claim changed");
    },
    blindSolveBeforePublish: async (scope, { job, publishInput, providerOutput, parentBudget, beforeSend }) => {
      // Legacy/unconfigured runs remain unknown without a provider or extra persistence I/O.
      if (!teachingBlindSolveConfig()) return [];
      const staged = stagedPublication(publishInput);
      const revision = { id: staged.compiled.revisionId, blocks: staged.compiled.blocks };
      const snapshot = providerOutput ? generatorSnapshots.get(providerOutput) : undefined;
      const configured = teachingBlindSolveConfig();
      const config = configured && snapshot?.providerId === configured.generator.providerId
        && snapshot.modelName === configured.generator.modelName ? configured : null;
      const sourceVersions: Record<string, number> = {};
      let versionsKnown = true;
      for (const ref of publishInput.sourceRefs ?? []) {
        const version = ref.version == null ? NaN : Number(ref.version);
        if (!Number.isSafeInteger(version) || version < 0 || (ref.sourceId in sourceVersions && sourceVersions[ref.sourceId] !== version)) versionsKnown = false;
        else sourceVersions[ref.sourceId] = version;
      }
      const assertCurrent = async () => {
        await beforeSend();
        await assertGenerationCurrent(scope, staged.pinned);
        await assertOpeningCourseRouteReady(sql, scope, publishInput.activityId);
        for (const [sourceId, version] of Object.entries(sourceVersions)) {
          const rows = await sql`SELECT id FROM opening_sources WHERE id=${sourceId} AND workspace_id=${scope.workspaceId}
            AND version=${version} AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=${sourceId})`;
          if (!rows.length) throw new Error("blind solve source version changed");
        }
      };
      const receipts: TeachingBlindSolveReceipt[] = [];
      const order = [...publishInput.blockOrder].sort((a, b) => a.position - b.position);
      // First usable slice: at most ONE optional solve per compile job, preserving call headroom.
      // Unknown billing still blocks this SAME parent through the existing ledger, including repairs.
      let attemptedSolve = false;
      for (let i = 0; i < order.length; i++) {
        const ref = order[i]!;
        if (ref.role === "answer_key" || !(ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType))) continue;
        const pinned = resolveOpeningTeachingBlindSolveQuestion(revision.blocks, order, ref.blockId);
        const solveConfig = !attemptedSolve && versionsKnown && revision.id && pinned.reliable && pinned.keyText ? config : null;
        if (solveConfig) attemptedSolve = true;
        const operationId = `teaching-solve:${job.id}:${ref.blockId}`;
        const receipt = await solveTeachingBlind({
          scope, config: solveConfig,
          identity: { activityId: publishInput.activityId, teachingRevisionId: revision.id,
            blockId: ref.blockId, answerBlockId: pinned.answerBlockId, questionText: pinned.questionText, keyText: pinned.keyText,
            contentVersion: publishInput.expectedVersion + 1, sourceVersions,
            generatorModelIdentity: config?.generator ?? null },
          question: pinned.body, interaction: pinned.interaction, pinnedKey: pinned.keyText, gateway: models,
          options: { budget: scopeBudget(budget, scope), operationId, resultRef: `job:${job.id}:blind-solve:${ref.blockId}`,
            parentBudget, beforeSend: assertCurrent },
          persist: async value => {
            // Existing private job/result JSON, not generationConfig (which client-init projects).
            // Keep the claim and cancellation fence; a late solver cannot publish its receipt.
            await assertCurrent();
            const rows = await sql`UPDATE opening_jobs SET result=jsonb_set(COALESCE(result,'{}'::jsonb),
              ARRAY['teachingBlindSolveReceipts'], COALESCE(result->'teachingBlindSolveReceipts','{}'::jsonb)
                || ${sql.json({ [ref.blockId]: value } as never)})
              WHERE id=${job.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
                AND state='running' AND privacy_epoch=${job.privacyEpoch}
                AND claim_token IS NOT DISTINCT FROM ${job.claimToken ?? null}::uuid RETURNING id`;
            if (!rows.length) throw new Error("blind solve job claim changed");
          },
        });
        receipts.push(receipt);
      }
      await assertCurrent();
      return receipts;
    },
    verifyAfterPublish: teachingValidationOn
      ? (scope, input) => {
          // Check against the chunks the compiler pinned, not a fresh budget-filled
          // selection that may leave them out and fail source identity.
          const pinned = new Set(
            (input.publishInput.sourceRefs ?? []).flatMap((ref) => (ref.chunkId ? [ref.chunkId] : [])),
          );
          return createTeachingValidationAfterPublish({
            tools: { checkFormula: checkTeachingFormula },
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
