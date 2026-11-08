import { randomUUID } from "node:crypto";
import { readStoredTeachingOutline } from "./teaching-outline";
import { checkTeachingFormula } from "./teaching-formula-check";
import type { Sql } from "postgres";
import { type Scope, type ProviderOutput, type OpeningModelSnapshot } from "@aistudy/contracts";
import {
  createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository,
  readOpeningTeachingCompilerFocus,
  readOpeningTeachingParentBudget,
  assertOpeningCourseRouteReady,
  readOpeningCourseRouteEvidenceRefs,
  saveOpeningReservedCandidates,
  type OpeningBudgetRepository,
  type createOpeningPrivacyRepository,
  type createOpeningSourceChunksRepository,
} from "@aistudy/database";
// Repository helper shares the authoritative saved question/key projection (not a new provider channel).
import { resolveOpeningTeachingBlindSolveQuestion } from "../../../../packages/database/src/repositories/opening-teaching-question-evaluation";
import { createCompilerProviderInput, parseModelJson, solveTeachingBlind, type TeachingBlindSolveReceipt } from "@aistudy/ai";
import { z } from "zod";
import { teachingQuestionInteractionSchema } from "@aistudy/contracts";
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
  // Real lessons always use the model gateway. An explicit off switch fails the job
  // before budget/content writes instead of publishing an empty placeholder lesson.
  // V2-09: optional post-publish validation when OPENING_TEACHING_VALIDATION_ENABLED; off → leave needs_check.
  const teachingCompilerOn = isTeachingCompilerEnabled();
  const teachingValidationOn = isTeachingValidationEnabled();
  const models = createDbModelGateway(sql);
  const generatorSnapshots = new WeakMap<ProviderOutput, OpeningModelSnapshot>();
  const retrieveContext = createOpeningMaterialRetriever(sql, budget);
  const pageImages = shared.pageImages ?? createSourcePageImages(sql, openingPageStorage());
  const loadChunks = (ownedScope: unknown, sourceIds: string[]) => chunks.listForSources(ownedScope as Scope, sourceIds);
  const modelPath: Pick<CompileTeachingUnitDeps, "callModel" | "buildProviderInput"> = teachingCompilerOn
    ? {
        callModel: async (scope, input, options) => {
          let snapshot: OpeningModelSnapshot | undefined;
          const output = await models.call(scope, input.imageParts.length ? "teaching.compile-visual" : "teaching.compile", { budget: scopeBudget(budget, scope), input, ...options,
            onModel: model => { snapshot = model.modelSnapshot; },
            beforeSend: async () => { await assertOpeningCourseRouteReady(sql,scope,options.resultRef.replace(/^teaching_activity:/,""));await options.beforeSend?.(); } });
          if (snapshot) generatorSnapshots.set(output, snapshot);
          return output;
        },
        buildProviderInput: async (scope, payload, options) => {
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
            retrieveContext,
            loadPageImages: (ownedScope, input) => pageImages(ownedScope as Scope, input),
            readOutline: () => outline,
            parentBudget: options?.parentBudget,
            intentSummary: activity?.intentSummary,
            intentKind: activity?.intentKind,
            ...focus,
          })(scope, payload);
          if (activity?.routeManaged) input.instruction += "\n另在顶层 reservedQuestions 生成至多4道私有保留题，格式 {text,interaction:{kind:'numeric'},answer}。只支持纯算式有理数运算；不支持时返回空数组。不得在 blocks、讲解、例题、提示、标题中重复或引用任何保留题或其答案。保留题不是迁移能力证明，不提供身份或未曝光声明。";
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
          // Dedicated private slot is consumed before public library serialization.
          // The model cannot supply identity, trust or exposure receipts.
          let publicOutput = providerOutput;
          let reserved: unknown = [];
          if (activity?.routeManaged && providerOutput) {
            const raw: unknown = parseModelJson(providerOutput.text);
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid compile output");
            const { reservedQuestions, ...publicBody } = raw as Record<string, unknown>;
            reserved = z.array(z.object({text:z.string().trim().min(1).max(400),answer:z.string().trim().min(1).max(1200),
              interaction:teachingQuestionInteractionSchema}).strict()).max(12).parse(reservedQuestions ?? []);
            const publicText = JSON.stringify(publicBody);
            for (const question of reserved as Array<{text:string;answer:string}>) {
              if (publicText.includes(question.text) || publicText.includes(question.answer))
                throw new Error("private reserved output overlaps public teaching content");
            }
            publicOutput = { ...providerOutput, text: publicText };
          }
          const publishInput = await build(scope, payload, publicOutput);
          if (compiledBlocks == null) throw new Error("compiled blocks were not built");
          // Fail before saving model bodies, even when post-publish validation is off.
          await teachingContent.validateActivitySourceRefs(scope, publishInput);
          if (activity?.routeManaged) await saveOpeningReservedCandidates(sql, scope, payload.activityId, reserved);
          const written = await teachingContent.writeUnitBlocks(scope, payload.teachingUnitId!, compiledBlocks);
          // Publication revalidates atomically; preflight cannot authorize a later write.
          const result = { ...publishInput, revisionNumber: written.revisionNumber };
          preflightedInputs.add(result);
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
      const unit = await teachingContent.getUnit(scope, publishInput.teachingUnitId);
      if (!unit) throw new Error("blind solve teaching unit missing");
      const revision = await teachingContent.readRevision(scope, unit.documentId, publishInput.revisionNumber);
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
