import { describe, expect, it } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import { canClaimJob, isUnknownOutcome } from "./run-job";
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
