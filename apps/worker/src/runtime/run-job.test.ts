import { describe, expect, it } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import { canClaimJob, isUnknownOutcome, runJob } from "./run-job";
import type { OpeningJobRecord } from "@aistudy/database";
import { jobQueueId } from "./queue";
import { handlers, handlerForKind } from "./handlers";

describe("opening worker runtime guards", () => {
  it("claims only queued or running jobs", () => {
    expect(canClaimJob("queued")).toBe(true);
    expect(canClaimJob("running")).toBe(true);
    expect(canClaimJob("succeeded")).toBe(false);
    expect(canClaimJob("cancelled")).toBe(false);
    expect(canClaimJob("failed")).toBe(false);
    expect(canClaimJob("outcome_unknown")).toBe(false);
  });

  it("uses provider error codes for unknown outcomes", () => {
    expect(isUnknownOutcome(new Error("PROVIDER_NETWORK"))).toBe(false);
    expect(isUnknownOutcome(new OpeningProviderError("PROVIDER_TIMEOUT", "timed out"))).toBe(true);
    expect(isUnknownOutcome(new OpeningProviderError("PROVIDER_AUTH", "unauthorized"))).toBe(false);
  });

  it("creates deterministic dash-safe queue IDs", () => {
    const id = jobQueueId("workspace-1", "job-2");
    expect(id).toBe("opening-ws-workspace-1-job-job-2");
    expect(id).not.toContain(":");
    expect(jobQueueId("workspace-1", "job-2")).toBe(id);
  });

  it("exposes only supported handlers and rejects unknown kinds", async () => {
    expect(Object.keys(handlers).sort()).toEqual(["parse", "remind", "retest", "tutor"]);
    await expect(handlers.parse({} as never, {})).rejects.toThrow("not implemented until I02/T02");
    expect(() => handlerForKind("unknown")).toThrow("unknown opening job kind");
  });
});


describe("runJob workspace privacy epoch (M02-wire)", () => {
  function baseJob(over: Partial<OpeningJobRecord> = {}): OpeningJobRecord {
    return {
      id: "job-1",
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      key: "k1",
      kind: "remind",
      payload: {},
      result: null,
      state: "queued",
      privacyEpoch: 1,
      ...over,
    };
  }

  it("rejects final writeback when workspace epoch bumped mid-job", async () => {
    let epoch = 1;
    const finished: Array<{ state: string; value: unknown }> = [];
    const repository = {
      claim: async () => baseJob(),
      sourcePrivacyEpoch: async () => 1,
      workspacePrivacyEpoch: async () => epoch,
      finish: async (_id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown) => {
        finished.push({ state, value });
        return true;
      },
    };
    const ok = await runJob(repository, "job-1", async () => {
      epoch = 2;
      return { ok: true };
    });
    expect(ok).toBe(false);
    expect(finished).toEqual([
      { state: "failed", value: { error: "workspace privacy epoch changed before writeback" } },
    ]);
  });

  it("succeeds when epoch stays current", async () => {
    const finished: string[] = [];
    const repository = {
      claim: async () => baseJob({ privacyEpoch: 3 }),
      sourcePrivacyEpoch: async () => 3,
      workspacePrivacyEpoch: async () => 3,
      finish: async (_id: string, state: "succeeded" | "failed" | "outcome_unknown") => {
        finished.push(state);
        return true;
      },
    };
    expect(await runJob(repository, "job-1", async () => ({ ok: true }))).toBe(true);
    expect(finished).toEqual(["succeeded"]);
  });
});
