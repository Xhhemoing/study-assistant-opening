import { openingJobScope } from "@aistudy/database";
import type {
  ActivitySpecPublishInput,
  ProviderInput,
  ProviderOutput,
  Scope,
} from "@aistudy/contracts";
import {
  OpeningProviderError,
  createCompilerBuildPublishInput,
  createTeachingValidationAfterPublish,
  isTeachingCompilerEnabled,
  isTeachingValidationEnabled,
  type BuildCompilerPublishInputOptions,
  type ParentInteractionBudget,
} from "@aistudy/ai";
import type { NextVerificationStatus, ValidationReport } from "@aistudy/domain";
import {
  OpeningBudgetError,
  type OpeningBudgetRepository,
  type OpeningJobRecord,
} from "@aistudy/database";
import { assertCurrentEpoch, PrivacyEpochError } from "../runtime/privacy-guard";
import {
  isBudgetReplayError,
  runBudgetedCall,
  type BudgetedProvider,
  type BudgetedRepository,
} from "@aistudy/ai";

export type CompileTeachingUnitMode = "generate" | "repair";

export type CompileTeachingUnitPayload = {
  mode: CompileTeachingUnitMode;
  activityId: string;
  teachingUnitId?: string;
  expectedContentVersion: number;
  expectedUnitVersion?: number;
  sourceIds?: string[];
  clientKey: string;
};

export type TeachingGenerateStatus =
  | "queued"
  | "generating"
  | "needs_check"
  | "ready"
  | "failed"
  | "unknown"
  | "cancelled"
  | "stale";

export type CompileTeachingUnitDeps = {
  budget: Pick<OpeningBudgetRepository, "reserve" | "release" | "claimExecution" | "settle" | "markUnknown">;
  /** Stub provider OK until V2-08; null disables model path. Ignored when callModel is set. */
  provider: BudgetedProvider | null;
  /**
   * Real model path (teaching.compile via the model gateway): routing, reservation
   * sizing, snapshot and settle all happen there. Budget replay errors propagate
   * exactly as from runBudgetedCall.
   */
  resolveParentBudget?(scope: Scope, payload: CompileTeachingUnitPayload): Promise<ParentInteractionBudget>;
  callModel?(
    scope: Scope,
    input: ProviderInput,
    options: { operationId: string; resultRef: string; parentBudget?: ParentInteractionBudget; beforeSend?: () => Promise<void> },
  ): Promise<ProviderOutput>;
  /** Prompt with outline + authorized evidence; defaults to the V2-07 stub prompt. */
  buildProviderInput?(scope: Scope, payload: CompileTeachingUnitPayload): Promise<ProviderInput>;
  reservedCents?: number;
  /**
   * When true and mode=repair, skip provider and set generate_status=ready
   * (deterministic index rewrite). Default false → repair still budgeted.
   */
  skipProviderForRepair?: boolean;
  setGenerateStatus(
    scope: Scope,
    activityId: string,
    status: TeachingGenerateStatus,
    options?: { from?: readonly TeachingGenerateStatus[] },
  ): Promise<boolean>;
  publishActivitySpec(scope: Scope, input: ActivitySpecPublishInput): Promise<unknown>;
  /**
   * PR-D replay: resolve a ledger resultRef ("teaching_activity:<id>") to the
   * persisted activity (scope-bound). Null when absent/foreign.
   */
  loadReplayedResult(
    scope: Scope,
    resultRef: string,
  ): Promise<{ activityId: string; generateStatus: TeachingGenerateStatus } | null>;
  /** Re-read job state before write-back (cancel race). */
  getJobState(jobId: string): Promise<string | null>;
  /**
   * Build publish input after (optional) provider call.
   * Stub default uses payload.teachingUnitId + empty blockOrder.
   */
  buildPublishInput?(
    scope: Scope,
    payload: CompileTeachingUnitPayload,
    providerOutput: ProviderOutput | null,
  ): Promise<ActivitySpecPublishInput>;
  /** Create-or-bind unit when generate omits teachingUnitId. */
  ensureTeachingUnitId?(
    scope: Scope,
    payload: CompileTeachingUnitPayload,
  ): Promise<string>;
  privacy?: {
    getWorkspaceEpoch(scope: Scope): Promise<number>;
    listExcludedSourceIds(scope: Scope): Promise<string[]>;
  };
  /**
   * V2-09 optional post-publish validation. Called only when
   * OPENING_TEACHING_VALIDATION_ENABLED is on and generate path reached needs_check.
   * Return null to leave needs_check; otherwise CAS-promote verificationStatus
   * (and optional generate_status) without rewriting learned history bodies.
   */
  verifyAfterPublish?(
    scope: Scope,
    input: {
      activityId: string;
      publishInput: ActivitySpecPublishInput;
      providerOutput: ProviderOutput | null;
    },
  ): Promise<{
    nextVerificationStatus: NextVerificationStatus;
    nextGenerateStatus?: TeachingGenerateStatus;
    report?: ValidationReport;
  } | null>;
};

function parsePayload(payload: unknown): CompileTeachingUnitPayload {
  const body = payload as CompileTeachingUnitPayload | null;
  if (!body || typeof body !== "object") {
    throw new Error("compile-teaching-unit payload missing");
  }
  if (body.mode !== "generate" && body.mode !== "repair") {
    throw new Error("compile-teaching-unit payload.mode must be generate|repair");
  }
  if (typeof body.activityId !== "string" || !body.activityId) {
    throw new Error("compile-teaching-unit payload missing activityId");
  }
  if (
    typeof body.expectedContentVersion !== "number" ||
    !Number.isInteger(body.expectedContentVersion) ||
    body.expectedContentVersion < 0
  ) {
    throw new Error("compile-teaching-unit payload missing expectedContentVersion");
  }
  if (typeof body.clientKey !== "string" || body.clientKey.length < 8) {
    throw new Error("compile-teaching-unit payload clientKey is too short");
  }
  if (body.mode === "repair" && (typeof body.teachingUnitId !== "string" || !body.teachingUnitId)) {
    throw new Error("compile-teaching-unit repair requires teachingUnitId");
  }
  return body;
}

function defaultStubPublish(
  payload: CompileTeachingUnitPayload,
  teachingUnitId: string,
): ActivitySpecPublishInput {
  const revisionNumber =
    typeof payload.expectedUnitVersion === "number" && payload.expectedUnitVersion > 0
      ? payload.expectedUnitVersion
      : 1;
  return {
    activityId: payload.activityId,
    teachingUnitId,
    expectedVersion: payload.expectedContentVersion,
    revisionNumber,
    blockOrder: [],
    sourceRefs: (payload.sourceIds ?? []).map((sourceId) => ({ sourceId })),
    verificationStatus: "unchecked",
    generationConfig: { extras: { stub: true, mode: payload.mode } },
  };
}

async function mapFailureStatus(
  error: unknown,
): Promise<TeachingGenerateStatus> {
  if (error instanceof PrivacyEpochError) return "stale";
  if (
    error instanceof OpeningProviderError &&
    (error.code === "PROVIDER_TIMEOUT" || error.code === "PROVIDER_NETWORK")
  ) {
    return "unknown";
  }
  return "failed";
}


/** Thin V2-08 wire: when enabled, buildPublishInput uses teaching-compiler. */
export function createTeachingCompilerPublishInput(
  options: BuildCompilerPublishInputOptions = {},
) {
  return createCompilerBuildPublishInput(options);
}

/** Thin V2-09 wire: post-publish verifyAfterPublish factory. */
export { createTeachingValidationAfterPublish };

export { isTeachingCompilerEnabled, isTeachingValidationEnabled };

/**
 * V2-07 teaching generation job: budgeted provider call + ActivitySpec publish fences.
 * operationId = compile-teaching-unit:{job.id} — never attempt-suffixed.
 * Runs under runJob (epoch pre/post check); not the tutor special-case path.
 */
export function createCompileTeachingUnitHandler(deps: CompileTeachingUnitDeps) {
  return async function processCompileTeachingUnit(
    job: OpeningJobRecord,
    payload: unknown,
  ): Promise<unknown> {
    const body = parsePayload(payload);
    const scope = openingJobScope(job);
    const operationId = `compile-teaching-unit:${job.id}`;

    const scopedBudget: BudgetedRepository = {
      reserve: (input) => deps.budget.reserve(scope, input),
      release: (requestId, reason) => deps.budget.release(scope, requestId, reason),
      claimExecution: (reservationId) => deps.budget.claimExecution(scope, reservationId),
      settle: (...args) => deps.budget.settle(scope, ...args),
      markUnknown: (reservationId) => deps.budget.markUnknown(scope, reservationId),
    };

    try {
      await deps.setGenerateStatus(scope, body.activityId, "generating", {
        from: ["queued", "generating"],
      });

      const excluded = new Set(
        deps.privacy ? await deps.privacy.listExcludedSourceIds(scope) : [],
      );
      const requestedSources = body.sourceIds ?? [];
      const allowedSources = requestedSources.filter((id) => !excluded.has(id));
      if (requestedSources.length > 0 && allowedSources.length === 0) {
        throw new Error("all requested source material is privacy-excluded");
      }

      const skipProvider = body.mode === "repair" && deps.skipProviderForRepair === true;
      let providerOutput: ProviderOutput | null = null;

      if (!skipProvider) {
        const parentBudget = deps.resolveParentBudget
          ? await deps.resolveParentBudget(scope, body)
          : { id: `study-activity:${body.activityId}` };
        const input: ProviderInput = deps.buildProviderInput
          ? await deps.buildProviderInput(scope, { ...body, sourceIds: allowedSources })
          : {
              instruction: deps.buildPublishInput
                ? "Compile the current teaching activity from editable outline + authorized sources (V2-08)."
                : "Compile a teaching unit from authorized sources (stub until V2-08).",
              text: JSON.stringify({
                mode: body.mode,
                activityId: body.activityId,
                teachingUnitId: body.teachingUnitId ?? null,
                sourceIds: allowedSources,
              }),
              chunks: [],
              mode: "explain",
              maxOutputTokens: 256,
              mediaCapability: "text_only",
              imageParts: [],
            };
        const beforeSend = deps.privacy
          ? async () =>
              assertCurrentEpoch(
                job.privacyEpoch,
                await deps.privacy!.getWorkspaceEpoch(scope),
              )
          : undefined;
        // Persisted result reference: the teaching activity this call compiles.
        const resultRef = `teaching_activity:${body.activityId}`;
        try {
          providerOutput = deps.callModel
            ? await deps.callModel(scope, input, { operationId, resultRef, parentBudget, ...(beforeSend ? { beforeSend } : {}) })
            : await runBudgetedCall({
                provider: deps.provider,
                budget: scopedBudget,
                input,
                requestId: operationId,
                operationId,
                purpose: "compile-teaching-unit",
                parentBudget,
                resultRef,
                reservedCents: deps.reservedCents ?? 100,
                actualCents: () => Math.min(deps.reservedCents ?? 100, 50),
                beforeSend,
              });
        } catch (error) {
          // PR-D: completed ledger key → load the persisted result via resultRef;
          // no provider call, no new charge, no re-publish, never fake success.
          if (isBudgetReplayError(error) && error.disposition.kind === "completed") {
            const ref = error.disposition.resultRef;
            const persisted = ref ? await deps.loadReplayedResult(scope, ref) : null;
            if (
              persisted && persisted.activityId === body.activityId
              && (persisted.generateStatus === "needs_check" || persisted.generateStatus === "ready")
            ) {
              return { replayed: true, activityId: persisted.activityId, generateStatus: persisted.generateStatus };
            }
            await deps.setGenerateStatus(scope, body.activityId, "unknown", {
              from: ["queued", "generating"],
            });
            throw Object.assign(
              new Error("compile-teaching-unit: provider call already settled but its result is not persisted; not re-sending"),
              { code: "BUDGET_REPLAY_RESULT_MISSING", cause: error },
            );
          }
          // Released / completed ledger on same operationId → non-retryable for this job.
          // Replayed ledger key (completed / released / unknown / in-flight):
          // never re-send under the same operationId; surface as non-retryable.
          if ((error instanceof OpeningBudgetError && error.code === "CONFLICT") || isBudgetReplayError(error)) {
            await deps.setGenerateStatus(scope, body.activityId, "failed", {
              from: ["queued", "generating"],
            });
            throw Object.assign(
              new Error("compile-teaching-unit budget reservation conflict; not retrying with new operationId"),
              { code: "BUDGET_CONFLICT", cause: error },
            );
          }
          throw error;
        }
      }

      const state = await deps.getJobState(job.id);
      if (state === "cancelled") {
        return { discarded: true, reason: "cancelled" };
      }

      if (deps.privacy) {
        assertCurrentEpoch(job.privacyEpoch, await deps.privacy.getWorkspaceEpoch(scope));
      }

      let teachingUnitId = body.teachingUnitId;
      if (!teachingUnitId) {
        if (!deps.ensureTeachingUnitId) {
          throw new Error("compile-teaching-unit generate requires teachingUnitId or ensureTeachingUnitId");
        }
        teachingUnitId = await deps.ensureTeachingUnitId(scope, body);
      }

      const publishInput = deps.buildPublishInput
        ? await deps.buildPublishInput(scope, { ...body, teachingUnitId, sourceIds: allowedSources }, providerOutput)
        : defaultStubPublish({ ...body, teachingUnitId, sourceIds: allowedSources }, teachingUnitId);

      // Re-check cancel immediately before publish (late-result fence).
      const stateBeforePublish = await deps.getJobState(job.id);
      if (stateBeforePublish === "cancelled") {
        return { discarded: true, reason: "cancelled" };
      }

      await deps.publishActivitySpec(scope, publishInput);

      let nextStatus: TeachingGenerateStatus = skipProvider ? "ready" : "needs_check";
      const updated = await deps.setGenerateStatus(scope, body.activityId, nextStatus, {
        from: ["generating"],
      });
      if (!updated) {
        // cancelled/stale won the race — discard is success for the handler
        return { discarded: true, reason: "generate_status_fence" };
      }

      let verificationStatus: string | undefined = publishInput.verificationStatus;
      let validationReport: ValidationReport | undefined;

      // V2-09 thin post-compile validation (flag off → leave needs_check).
      // Keep cancel / epoch fences; do not rewrite learned history bodies.
      if (
        !skipProvider &&
        nextStatus === "needs_check" &&
        isTeachingValidationEnabled() &&
        deps.verifyAfterPublish
      ) {
        const stateBeforeValidate = await deps.getJobState(job.id);
        if (stateBeforeValidate === "cancelled") {
          return { discarded: true, reason: "cancelled" };
        }
        if (deps.privacy) {
          assertCurrentEpoch(job.privacyEpoch, await deps.privacy.getWorkspaceEpoch(scope));
        }

        const promotion = await deps.verifyAfterPublish(scope, {
          activityId: body.activityId,
          publishInput,
          providerOutput,
        });

        if (promotion) {
          const stateBeforePromote = await deps.getJobState(job.id);
          if (stateBeforePromote === "cancelled") {
            return { discarded: true, reason: "cancelled" };
          }
          if (deps.privacy) {
            assertCurrentEpoch(job.privacyEpoch, await deps.privacy.getWorkspaceEpoch(scope));
          }

          // CAS metadata republish: same graph + new verificationStatus (soft gap #1).
          await deps.publishActivitySpec(scope, {
            ...publishInput,
            expectedVersion: publishInput.expectedVersion + 1,
            verificationStatus: promotion.nextVerificationStatus,
          });
          verificationStatus = promotion.nextVerificationStatus;
          validationReport = promotion.report;

          if (promotion.nextGenerateStatus) {
            const promoted = await deps.setGenerateStatus(
              scope,
              body.activityId,
              promotion.nextGenerateStatus,
              { from: ["needs_check"] },
            );
            if (promoted) {
              nextStatus = promotion.nextGenerateStatus;
            }
          }
        }
      }

      return {
        activityId: body.activityId,
        teachingUnitId,
        mode: body.mode,
        generateStatus: nextStatus,
        operationId,
        usedProvider: !skipProvider,
        verificationStatus,
        validationReport,
      };
    } catch (error) {
      const status = await mapFailureStatus(error);
      await deps.setGenerateStatus(scope, body.activityId, status, {
        from: ["queued", "generating"],
      });
      throw error;
    }
  };
}
