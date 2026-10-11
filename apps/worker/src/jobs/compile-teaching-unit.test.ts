import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError, createCompilerBuildPublishInput } from "@aistudy/ai";
import { OpeningBudgetError } from "@aistudy/database";
import type { OpeningJobRecord } from "@aistudy/database";
import type { ProviderOutput, SourceChunk } from "@aistudy/contracts";
import {
  createCompileTeachingUnitHandler,
  isTeachingValidationEnabled,
} from "./compile-teaching-unit";
import { PrivacyEpochError } from "../runtime/privacy-guard";

const ACTIVITY = "00000000-0000-4000-8000-0000000000a1";
const UNIT = "00000000-0000-4000-8000-0000000000u1";
const SOURCE = "00000000-0000-4000-8000-0000000000s1";

const job: OpeningJobRecord = {
  id: "00000000-0000-4000-8000-0000000000j1",
  workspaceId: "00000000-0000-4000-8000-0000000000w1",
  ownerUserId: "00000000-0000-4000-8000-0000000000o1",
  key: "compile-teaching-unit:act:generate:client-key-01",
  kind: "compile-teaching-unit",
  payload: {},
  result: null,
  state: "running",
  privacyEpoch: 3,
};

const stubOutput: ProviderOutput = {
  text: "{}",
  citedChunkIds: [],
  requestId: null,
  candidates: [],
  inputTokens: 2,
  outputTokens: 2,
};

function baseDeps(overrides: Record<string, unknown> = {}) {
  const reserved: Array<{ purpose: string; requestId: string; amountCents: number }> = [];
  const released: string[] = [];
  const statuses: string[] = [];
  let jobState = "running";
  const publish = vi.fn(async () => ({ id: "spec-1" }));
  const setGenerateStatus = vi.fn(async (_s, _a, status: string) => {
    statuses.push(status);
    return true;
  });
  const deps = {
    budget: {
      reserve: async (scope: unknown, input: { purpose: string; requestId: string; amountCents: number }) => {
        void scope;
        const existing = reserved.find((r) => r.requestId === input.requestId);
        if (existing) {
          if (existing.purpose !== input.purpose) {
            throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
          }
          return { id: "res-replay", workspaceId: job.workspaceId, purpose: input.purpose, amountCents: input.amountCents, requestId: input.requestId, state: "reserved", modelSnapshot: null };
        }
        reserved.push(input);
        return { id: `res-${reserved.length}`, workspaceId: job.workspaceId, purpose: input.purpose, amountCents: input.amountCents, requestId: input.requestId, state: "reserved", modelSnapshot: null };
      },
      release: async (requestId: string) => {
        released.push(requestId);
        return { id: "res-1", workspaceId: job.workspaceId, purpose: "compile-teaching-unit", amountCents: 100, requestId, state: "released", modelSnapshot: null };
      },
      settle: async () => ({ id: "res-1", workspaceId: job.workspaceId, purpose: "compile-teaching-unit", amountCents: 50, requestId: "x", state: "completed", modelSnapshot: null }),
      markUnknown: async () => ({ id: "res-1", workspaceId: job.workspaceId, purpose: "compile-teaching-unit", amountCents: 100, requestId: "x", state: "reserved", modelSnapshot: null }),
    },
    provider: { complete: async () => stubOutput },
    reservedCents: 100,
    setGenerateStatus,
    publishActivitySpec: publish,
    getJobState: async () => jobState,
    privacy: {
      getWorkspaceEpoch: async () => 3,
      listExcludedSourceIds: async () => [] as string[],
    },
    _setJobState: (s: string) => {
      jobState = s;
    },
    _reserved: reserved,
    _released: released,
    _statuses: statuses,
    ...overrides,
  };
  return deps;
}

const generatePayload = {
  mode: "generate" as const,
  activityId: ACTIVITY,
  teachingUnitId: UNIT,
  expectedContentVersion: 0,
  clientKey: "client-key-01",
  sourceIds: [SOURCE],
};

describe("createCompileTeachingUnitHandler", () => {
  it("generate success → budget purpose compile-teaching-unit + needs_check write-back", async () => {
    const deps = baseDeps();
    const process = createCompileTeachingUnitHandler(deps as never);
    const result = await process(job, generatePayload);
    expect(result).toMatchObject({
      generateStatus: "needs_check",
      operationId: `compile-teaching-unit:${job.id}`,
      usedProvider: true,
    });
    expect(deps._reserved[0]).toMatchObject({
      purpose: "compile-teaching-unit",
      requestId: `compile-teaching-unit:${job.id}`,
    });
    expect(deps._statuses).toEqual(["generating", "needs_check"]);
    expect(deps.publishActivitySpec).toHaveBeenCalledWith(
      { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId },
      expect.objectContaining({
        activityId: ACTIVITY,
        teachingUnitId: UNIT,
        expectedVersion: 0,
      }),
    );
  });

  it("operationId never attempt-suffixed; released ledger CONFLICT → non-retryable fail", async () => {
    const deps = baseDeps({
      budget: {
        reserve: async () => {
          throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
        },
        release: async () => ({}),
        settle: async () => ({}),
        markUnknown: async () => ({}),
      },
    });
    const process = createCompileTeachingUnitHandler(deps as never);
    await expect(process(job, generatePayload)).rejects.toMatchObject({
      code: "BUDGET_CONFLICT",
    });
    expect(deps._statuses).toContain("failed");
    expect(deps.publishActivitySpec).not.toHaveBeenCalled();
  });

  it("cancel discards late write-back", async () => {
    const deps = baseDeps();
    deps.provider = {
      complete: async () => {
        deps._setJobState("cancelled");
        return stubOutput;
      },
    };
    const process = createCompileTeachingUnitHandler(deps as never);
    const result = await process(job, generatePayload);
    expect(result).toEqual({ discarded: true, reason: "cancelled" });
    expect(deps.publishActivitySpec).not.toHaveBeenCalled();
    expect(deps._statuses).not.toContain("needs_check");
  });

  it("purpose propagates as compile-teaching-unit on reserve", async () => {
    const deps = baseDeps();
    const process = createCompileTeachingUnitHandler(deps as never);
    await process(job, generatePayload);
    expect(deps._reserved.map((r) => r.purpose)).toEqual(["compile-teaching-unit"]);
  });

  it("non-model repair sets ready without provider", async () => {
    const deps = baseDeps({ skipProviderForRepair: true });
    const process = createCompileTeachingUnitHandler(deps as never);
    const result = await process(job, {
      mode: "repair",
      activityId: ACTIVITY,
      teachingUnitId: UNIT,
      expectedContentVersion: 1,
      clientKey: "client-key-02",
    });
    expect(result).toMatchObject({ generateStatus: "ready", usedProvider: false });
    expect(deps._reserved).toHaveLength(0);
    expect(deps.publishActivitySpec).toHaveBeenCalled();
  });

  it("epoch mismatch before send → stale, no publish", async () => {
    const deps = baseDeps({
      privacy: {
        getWorkspaceEpoch: async () => 9,
        listExcludedSourceIds: async () => [],
      },
    });
    const process = createCompileTeachingUnitHandler(deps as never);
    await expect(process(job, generatePayload)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(deps._statuses).toContain("stale");
    expect(deps.publishActivitySpec).not.toHaveBeenCalled();
    expect(deps._released).toEqual([`compile-teaching-unit:${job.id}`]);
  });

  it("provider timeout → unknown activity status", async () => {
    const deps = baseDeps({
      provider: {
        complete: async () => {
          throw new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", true);
        },
      },
    });
    const process = createCompileTeachingUnitHandler(deps as never);
    await expect(process(job, generatePayload)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(deps._statuses).toContain("unknown");
    expect(deps.publishActivitySpec).not.toHaveBeenCalled();
  });

  it("all sources privacy-excluded → failed without publish", async () => {
    const deps = baseDeps({
      privacy: {
        getWorkspaceEpoch: async () => 3,
        listExcludedSourceIds: async () => [SOURCE],
      },
    });
    const process = createCompileTeachingUnitHandler(deps as never);
    await expect(process(job, generatePayload)).rejects.toThrow(/privacy-excluded/);
    expect(deps.publishActivitySpec).not.toHaveBeenCalled();
    expect(deps._statuses).toContain("failed");
  });

  it("C10: compiler buildPublishInput → needs_check, non-empty blockOrder, no extras.stub", async () => {
    let blockSeq = 0;
    const chunk: SourceChunk = {
      id: "c1",
      sourceId: SOURCE,
      sourceVersion: 1,
      page: 1,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: "authorized nullspace material for compile",
      imageObjectKey: null,
    };
    const buildPublishInput = createCompilerBuildPublishInput({
      loadChunks: async (_scope, _ids) => [chunk],
      intentSummary: "compile current teaching activity",
      intentKind: "material",
      newBlockId: () => {
        blockSeq += 1;
        return `00000000-0000-4000-8000-${String(blockSeq).padStart(12, "0")}`;
      },
    });
    const deps = baseDeps({ buildPublishInput });
    const process = createCompileTeachingUnitHandler(deps as never);
    const result = await process(job, generatePayload);
    expect(result).toMatchObject({
      generateStatus: "needs_check",
      operationId: `compile-teaching-unit:${job.id}`,
      usedProvider: true,
    });
    expect(deps._statuses).toEqual(["generating", "needs_check"]);
    expect(deps.publishActivitySpec).toHaveBeenCalled();
    const publishArg = deps.publishActivitySpec.mock.calls[0][1];
    expect(publishArg.blockOrder.length).toBeGreaterThan(0);
    expect(publishArg.generationConfig?.extras?.stub).toBeUndefined();
    expect(publishArg.verificationStatus).toBe("needs_check");
    // budget fence still exercised
    expect(deps._reserved[0]).toMatchObject({
      purpose: "compile-teaching-unit",
      requestId: `compile-teaching-unit:${job.id}`,
    });
  });

  it("C10b: stub fallback when buildPublishInput absent keeps extras.stub", async () => {
    const deps = baseDeps();
    const process = createCompileTeachingUnitHandler(deps as never);
    await process(job, generatePayload);
    const publishArg = deps.publishActivitySpec.mock.calls[0][1];
    expect(publishArg.blockOrder).toEqual([]);
    expect(publishArg.generationConfig?.extras?.stub).toBe(true);
  });

  it("C10 validation: flag off leaves needs_check (no verifyAfterPublish call)", async () => {
    const verifyAfterPublish = vi.fn(async () => ({
      nextVerificationStatus: "verified" as const,
      nextGenerateStatus: "ready" as const,
    }));
    const prev = process.env.OPENING_TEACHING_VALIDATION_ENABLED;
    delete process.env.OPENING_TEACHING_VALIDATION_ENABLED;
    try {
      expect(isTeachingValidationEnabled()).toBe(false);
      const deps = baseDeps({ verifyAfterPublish });
      const processJob = createCompileTeachingUnitHandler(deps as never);
      const result = await processJob(job, generatePayload);
      expect(result).toMatchObject({ generateStatus: "needs_check" });
      expect(verifyAfterPublish).not.toHaveBeenCalled();
      expect(deps.publishActivitySpec).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.OPENING_TEACHING_VALIDATION_ENABLED;
      else process.env.OPENING_TEACHING_VALIDATION_ENABLED = prev;
    }
  });

  it("C10 validation: flag on + fact pass → verified + optional ready; fences kept", async () => {
    const verifyAfterPublish = vi.fn(async () => ({
      nextVerificationStatus: "verified" as const,
      nextGenerateStatus: "ready" as const,
      report: {
        activityId: ACTIVITY,
        structurePassed: true,
        factPassed: true,
        layers: [],
        nextVerificationStatus: "verified" as const,
        presentation: { kind: "authoritative" as const, allowsFormalScoring: true as const },
      },
    }));
    const prev = process.env.OPENING_TEACHING_VALIDATION_ENABLED;
    process.env.OPENING_TEACHING_VALIDATION_ENABLED = "1";
    try {
      expect(isTeachingValidationEnabled()).toBe(true);
      const deps = baseDeps({ verifyAfterPublish });
      const processJob = createCompileTeachingUnitHandler(deps as never);
      const result = await processJob(job, generatePayload);
      expect(result).toMatchObject({
        generateStatus: "ready",
        verificationStatus: "verified",
        operationId: `compile-teaching-unit:${job.id}`,
      });
      expect(verifyAfterPublish).toHaveBeenCalledTimes(1);
      // initial publish + CAS promote
      expect(deps.publishActivitySpec).toHaveBeenCalledTimes(2);
      const promoteArg = deps.publishActivitySpec.mock.calls[1][1];
      expect(promoteArg.verificationStatus).toBe("verified");
      expect(promoteArg.expectedVersion).toBe(1); // 0+1 after first publish
      expect(deps._statuses).toEqual(["generating", "needs_check", "ready"]);
      // budget fence still exercised once
      expect(deps._reserved[0]).toMatchObject({
        purpose: "compile-teaching-unit",
        requestId: `compile-teaching-unit:${job.id}`,
      });
    } finally {
      if (prev === undefined) delete process.env.OPENING_TEACHING_VALIDATION_ENABLED;
      else process.env.OPENING_TEACHING_VALIDATION_ENABLED = prev;
    }
  });

  it("C10 validation: unknown/conflict promotion leaves generate needs_check", async () => {
    const verifyAfterPublish = vi.fn(async () => ({
      nextVerificationStatus: "needs_check" as const,
      report: {
        activityId: ACTIVITY,
        structurePassed: true,
        factPassed: false,
        layers: [],
        nextVerificationStatus: "needs_check" as const,
        presentation: {
          kind: "discussion_draft" as const,
          allowsFormalScoring: false as const,
          label: "draft",
        },
      },
    }));
    const prev = process.env.OPENING_TEACHING_VALIDATION_ENABLED;
    process.env.OPENING_TEACHING_VALIDATION_ENABLED = "true";
    try {
      const deps = baseDeps({ verifyAfterPublish });
      const processJob = createCompileTeachingUnitHandler(deps as never);
      const result = await processJob(job, generatePayload);
      expect(result).toMatchObject({
        generateStatus: "needs_check",
        verificationStatus: "needs_check",
      });
      expect(deps._statuses).toEqual(["generating", "needs_check"]);
      expect(deps.publishActivitySpec).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.OPENING_TEACHING_VALIDATION_ENABLED;
      else process.env.OPENING_TEACHING_VALIDATION_ENABLED = prev;
    }
  });

});
