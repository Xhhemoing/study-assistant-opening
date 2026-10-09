import { describe, expect, it, vi } from "vitest";

const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000s1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000a1";
const RETEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SOURCE = "00000000-0000-4000-8000-0000000000f1";

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
    get: vi.fn(async () => ({
      snapshot: { nodes: [{ id: NODE, label: "chain rule" }], edges: [], courseId: COURSE, version: 1 },
    })),
  }),
}));

const insertObservationMock = vi.fn(async (_scope: unknown, input: unknown) => input);

vi.mock("@aistudy/domain", async () => {
  const actual = await vi.importActual<typeof import("@aistudy/domain")>("@aistudy/domain");
  return {
    ...actual,
    resolveAssistance: (_claimed: string) => "independent" as const,
  };
});

/** Tagged-template sql mock returning past earliest floors so submit proceeds. */
function sqlPastRetest() {
  const fn = async () => [
    {
      not_before_at: "2026-09-01T00:00:00.000Z",
      recommended_at: "2026-09-01T00:00:00.000Z",
      scheduled_start_at: null,
    },
  ];
  return fn as never;
}

describe("attempt submit retest SkillEvidence enrichment", () => {
  it("adds nodeId+dimension transfer on independent retest submit", async () => {
    insertObservationMock.mockClear();
    const { createOpeningAttemptService } = await import("./attempt-service");
    const service = createOpeningAttemptService(sqlPastRetest());
    const scope = {
      workspaceId: "00000000-0000-4000-8000-0000000000w1",
      ownerUserId: "00000000-0000-4000-8000-0000000000u1",
    };
    await service.submit(scope, ATTEMPT, {
      clientKey: "retest-close-key-1",
      answer: "42",
      outcome: "correct",
      assistance: "independent",
      retestId: RETEST,
    });
    expect(insertObservationMock).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        retestId: RETEST,
        nodeId: NODE,
        dimension: "transfer",
        assistance: "independent",
        skillLabel: "chain rule",
      }),
    );
  });
});
