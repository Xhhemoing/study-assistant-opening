import { describe, expect, it, vi, beforeEach } from "vitest";
import { RETEST_SUBMIT_TOO_EARLY_MESSAGE, RetestSubmitTooEarlyError } from "@aistudy/domain";

const COURSE = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000s1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000a1";
const RETEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SOURCE = "00000000-0000-4000-8000-0000000000f1";

const insertObservationMock = vi.fn(async (_scope: unknown, input: unknown) => input);
const sqlRowsMock = vi.fn();

vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({
    create: vi.fn(),
    get: vi.fn(),
    assertAccess: vi.fn(async () => ({
      id: ATTEMPT,
      sessionId: SESSION,
      courseId: COURSE,
      skillLabel: "chain rule",
      sourceIds: [SOURCE],
      problemId: null,
    })),
  }),
  createOpeningLearningRepository: () => ({
    listDeliveredExposures: vi.fn(async () => []),
    insertObservation: insertObservationMock,
  }),
  createOpeningKnowledgeRepository: () => ({
    get: vi.fn(async () => null),
  }),
}));

vi.mock("@aistudy/domain", async () => {
  const actual = await vi.importActual<typeof import("@aistudy/domain")>("@aistudy/domain");
  return {
    ...actual,
    resolveAssistance: (_claimed: string) => "independent" as const,
  };
});

function sqlMock() {
  const fn = async () => sqlRowsMock();
  return fn as never;
}

const scope = {
  workspaceId: "00000000-0000-4000-8000-0000000000w1",
  ownerUserId: "00000000-0000-4000-8000-0000000000u1",
};

const submitBody = {
  clientKey: "retest-earliest-key-1",
  answer: "42",
  outcome: "correct" as const,
  assistance: "independent" as const,
  retestId: RETEST,
};

describe("attempt submit retest earliest gate (DL11)", () => {
  beforeEach(() => {
    insertObservationMock.mockClear();
    sqlRowsMock.mockReset();
  });

  it("rejects early retest submit and does not insert observation", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    sqlRowsMock.mockReturnValue([
      {
        not_before_at: null,
        recommended_at: future,
        scheduled_start_at: null,
      },
    ]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    const service = createOpeningAttemptService(sqlMock());
    await expect(service.submit(scope, ATTEMPT, submitBody)).rejects.toBeInstanceOf(RetestSubmitTooEarlyError);
    try {
      await service.submit(scope, ATTEMPT, submitBody);
    } catch (error) {
      expect(error).toBeInstanceOf(RetestSubmitTooEarlyError);
      expect((error as Error).message).toBe(RETEST_SUBMIT_TOO_EARLY_MESSAGE);
      expect((error as RetestSubmitTooEarlyError).code).toBe("VALIDATION");
    }
    expect(insertObservationMock).not.toHaveBeenCalled();
  });

  it("rejects when not_before_at is still in the future", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    sqlRowsMock.mockReturnValue([
      {
        not_before_at: future,
        recommended_at: past,
        scheduled_start_at: null,
      },
    ]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    const service = createOpeningAttemptService(sqlMock());
    await expect(service.submit(scope, ATTEMPT, submitBody)).rejects.toBeInstanceOf(RetestSubmitTooEarlyError);
    expect(insertObservationMock).not.toHaveBeenCalled();
  });

  it("allows on-time retest submit and proceeds to insertObservation", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    sqlRowsMock.mockReturnValue([
      {
        not_before_at: past,
        recommended_at: past,
        scheduled_start_at: null,
      },
    ]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    const service = createOpeningAttemptService(sqlMock());
    await service.submit(scope, ATTEMPT, submitBody);
    expect(insertObservationMock).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ retestId: RETEST, answer: "42" }),
    );
  });

  it("skips earliest query when submit has no retestId", async () => {
    sqlRowsMock.mockReturnValue([]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    const service = createOpeningAttemptService(sqlMock());
    await service.submit(scope, ATTEMPT, {
      clientKey: "ordinary-key-1",
      answer: "x",
      outcome: "unverified",
      assistance: "unknown",
    });
    expect(sqlRowsMock).not.toHaveBeenCalled();
    expect(insertObservationMock).toHaveBeenCalled();
  });
});
