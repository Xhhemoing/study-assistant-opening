import { describe, expect, it, vi } from "vitest";
import { createOpeningObservationService } from "./observation-service";

const ids = {
  session: "22222222-2222-4222-8222-222222222222",
  course: "33333333-3333-4333-8333-333333333333",
  source: "11111111-1111-4111-8111-111111111111",
  other: "44444444-4444-4444-8444-444444444444",
};

function input(over: Record<string, unknown> = {}) {
  return {
    sessionId: ids.session, courseId: ids.course, skillLabel: "fractions",
    sourceIds: [], answer: "1/2", outcome: "correct", assistance: "independent",
    clientKey: "obs-key-01", ...over,
  };
}

describe("observation verdict policy", () => {
  it("keeps an unknown outcome from becoming a formal correct verdict", async () => {
    const insertObservation = vi.fn(async (_scope, _input, opts) => opts);
    const service = createOpeningObservationService({
      getSession: vi.fn(async () => ({ id: ids.session, sourceIds: [] })),
      insertObservation,
    } as never);
    await service.submitObservation({ workspaceId: ids.other, ownerUserId: ids.other }, input({
      outcome: "unverified", assistance: "unknown", verdictSource: "unknown",
    }));
    expect(insertObservation.mock.calls[0][2]).toMatchObject({ verdictSource: "unknown" });
    expect(insertObservation.mock.calls[0][1].outcome).not.toBe("correct");
  });

  it("does not accept a client-only reference outside the session sources", async () => {
    const insertObservation = vi.fn();
    const service = createOpeningObservationService({
      getSession: vi.fn(async () => ({ id: ids.session, sourceIds: [ids.source] })),
      insertObservation,
    } as never);
    await expect(service.submitObservation(
      { workspaceId: ids.other, ownerUserId: ids.other },
      input({ verdictSource: "reference_checked", referenceSourceId: ids.other }),
    )).rejects.toMatchObject({ code: "VALIDATION" });
    expect(insertObservation).not.toHaveBeenCalled();
  });

  it("links a correction as a revision instead of replacing the parent", async () => {
    const insertObservation = vi.fn(async () => ({ id: "new" }));
    const service = createOpeningObservationService({
      getSession: vi.fn(async () => ({ id: ids.session, sourceIds: [] })),
      insertObservation,
    } as never);
    await expect(service.submitObservation(
      { workspaceId: ids.other, ownerUserId: ids.other },
      input({ revisesObservationId: ids.source, answer: "2/4" }),
    )).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertObservation).not.toHaveBeenCalled();
  });

  it("rejects unknown verdicts that claim a formal correct outcome", async () => {
    const insertObservation = vi.fn();
    const service = createOpeningObservationService({
      getSession: vi.fn(async () => ({ id: ids.session, sourceIds: [] })),
      insertObservation,
    } as never);
    await expect(service.submitObservation(
      { workspaceId: ids.other, ownerUserId: ids.other },
      input({ verdictSource: "unknown", outcome: "correct" }),
    )).rejects.toMatchObject({ code: "VALIDATION" });
    expect(insertObservation).not.toHaveBeenCalled();
  });

  it("keeps model suggestions and self reports as distinct stored verdicts", async () => {
    const insertObservation = vi.fn(async (_scope, _input, opts) => opts);
    const service = createOpeningObservationService({
      getSession: vi.fn(async () => ({ id: ids.session, sourceIds: [ids.source] })),
      insertObservation,
    } as never);
    const scope = { workspaceId: ids.other, ownerUserId: ids.other };
    await service.submitObservation(scope, input({ verdictSource: "model_suggestion", outcome: "unverified" }));
    await service.submitObservation(scope, input({
      clientKey: "obs-key-02", verdictSource: "reference_checked", referenceSourceId: ids.source,
    }));
    expect(insertObservation.mock.calls[0][2]).toMatchObject({ verdictSource: "model_suggestion" });
    expect(insertObservation.mock.calls[1][2]).toMatchObject({
      verdictSource: "reference_checked", referenceSourceId: ids.source,
    });
  });
});
