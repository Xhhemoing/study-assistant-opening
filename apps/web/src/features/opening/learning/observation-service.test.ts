import { describe, expect, it, vi } from "vitest";
import { createOpeningObservationService } from "./observation-service";

const ids = {
  session: "22222222-2222-4222-8222-222222222222",
  course: "33333333-3333-4333-8333-333333333333",
  source: "11111111-1111-4111-8111-111111111111",
  other: "44444444-4444-4444-8444-444444444444",
};
const scope = { workspaceId: ids.other, ownerUserId: ids.other };

function input(over: Record<string, unknown> = {}) {
  return {
    sessionId: ids.session, courseId: ids.course, skillLabel: "fractions",
    sourceIds: [], answer: "1/2", outcome: "correct", assistance: "independent",
    clientKey: "obs-key-01", ...over,
  };
}

describe("observation service boundary", () => {
  it("preserves unknown verdicts when delegating to the repository", async () => {
    const insertObservation = vi.fn(async () => ({ id: ids.other }));
    const service = createOpeningObservationService({ insertObservation } as never);
    const payload = input({
      outcome: "unverified", assistance: "unknown", verdictSource: "unknown",
    });

    await service.submitObservation(scope, payload);

    expect(insertObservation).toHaveBeenCalledExactlyOnceWith(scope, payload);
  });

  it("propagates repository rejection of a reference outside the session sources", async () => {
    const error = Object.assign(new Error("reference source is not bound to this session"), { code: "VALIDATION" });
    const insertObservation = vi.fn().mockRejectedValue(error);
    const service = createOpeningObservationService({ insertObservation } as never);
    const payload = input({ verdictSource: "reference_checked", referenceSourceId: ids.other });

    await expect(service.submitObservation(scope, payload)).rejects.toBe(error);
    expect(insertObservation).toHaveBeenCalledExactlyOnceWith(scope, payload);
  });

  it("propagates the repository conflict when a correction uses the submit API", async () => {
    const error = Object.assign(new Error("observation revision requires the separate revision API"), { code: "CONFLICT" });
    const insertObservation = vi.fn().mockRejectedValue(error);
    const service = createOpeningObservationService({ insertObservation } as never);
    const payload = input({ revisesObservationId: ids.source, answer: "2/4" });

    await expect(service.submitObservation(scope, payload)).rejects.toBe(error);
    expect(insertObservation).toHaveBeenCalledExactlyOnceWith(scope, payload);
  });

  it("preserves reported correctness and the repository's unknown verification eligibility", async () => {
    const payload = input({ verdictSource: "unknown", outcome: "correct" });
    const stored = { ...payload, id: ids.other, eligibility: { verifiedCorrect: "unknown" }, allowsIndependent: false };
    const insertObservation = vi.fn().mockResolvedValue(stored);
    const service = createOpeningObservationService({ insertObservation } as never);

    await expect(service.submitObservation(scope, payload)).resolves.toBe(stored);
    expect(insertObservation).toHaveBeenCalledExactlyOnceWith(scope, payload);
  });

  it("preserves model suggestions, self reports, and reference-check inputs", async () => {
    const insertObservation = vi.fn(async () => ({ id: ids.other }));
    const service = createOpeningObservationService({ insertObservation } as never);
    const payloads = [
      input({ verdictSource: "model_suggestion", outcome: "unverified" }),
      input({ clientKey: "obs-key-02", verdictSource: "self_report" }),
      input({
        clientKey: "obs-key-03", verdictSource: "reference_checked", referenceSourceId: ids.source,
        referenceCheck: { referenceSourceId: ids.source, method: "answer key", scope: "whole_answer" },
      }),
    ];

    for (const payload of payloads) await service.submitObservation(scope, payload);

    expect(insertObservation.mock.calls).toEqual(payloads.map((payload) => [scope, payload]));
  });

  it("rejects malformed observation input before calling the repository", () => {
    const insertObservation = vi.fn();
    const service = createOpeningObservationService({ insertObservation } as never);

    expect(() => service.submitObservation(scope, input({ sessionId: "invalid" }))).toThrow();
    expect(insertObservation).not.toHaveBeenCalled();
  });

  it("submits a validated correction through the separate revision API", async () => {
    const result = { disposition: "applied", headObservationId: ids.other };
    const reviseObservation = vi.fn().mockResolvedValue(result);
    const insertObservation = vi.fn();
    const service = createOpeningObservationService({ reviseObservation, insertObservation } as never);
    const payload = {
      rootObservationId: ids.source, revisesObservationId: ids.source, expectedHead: ids.source,
      revisionKind: "replace", replacement: { answer: "2/4", outcome: "correct", assistance: "independent" },
      reason: "  corrected answer  ", clientKey: "revision-key",
    };

    await expect(service.reviseObservation(scope, payload)).resolves.toBe(result);
    expect(reviseObservation).toHaveBeenCalledExactlyOnceWith(scope, { ...payload, reason: "corrected answer" });
    expect(insertObservation).not.toHaveBeenCalled();
  });
});
