import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetestSubmitTooEarlyError } from "@aistudy/domain";

/**
 * PR-B §4.1: the server (not the client) decides whether a retest submit is
 * on time and independent. Assistance is derived from delivered help exposures;
 * a client "independent" claim after a hint never links retest skill evidence.
 */
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000s1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000a1";
const RETEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const NODE = "00000000-0000-4000-8000-0000000000n1";

const insertObservation = vi.fn(async (_scope: unknown, input: unknown) => input);
const exposures = vi.fn(async (): Promise<string[]> => []);
const retestRows = vi.fn((): unknown[] => []);

vi.mock("./auto-grade-policy", () => ({ resolveAutoGradePolicy: async () => ({ enabled: true, modelAvailable: true, dailyCap: 50 }) }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({
    create: vi.fn(),
    get: vi.fn(),
    assertAccess: vi.fn(async () => ({
      id: ATTEMPT, sessionId: SESSION, courseId: COURSE, skillLabel: "chain rule", sourceIds: [], problemId: null,
    })),
  }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: exposures, insertObservation }),
  createOpeningKnowledgeRepository: () => ({
    get: vi.fn(async () => ({ snapshot: { nodes: [{ id: NODE, label: "chain rule" }] } })),
  }),
}));

const sql = (async () => retestRows()) as never;
const scope = { workspaceId: "00000000-0000-4000-8000-0000000000w1", ownerUserId: "00000000-0000-4000-8000-0000000000u1" };
const body = { clientKey: "retest-server-check-1", answer: "42", outcome: "correct" as const, assistance: "independent" as const };
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const inHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("attempt submit: server-side retest timing + independence (PR-B §4.1)", () => {
  beforeEach(() => { insertObservation.mockClear(); exposures.mockReset(); exposures.mockResolvedValue([]); retestRows.mockReset(); });

  it("on-time independent correct retest links skill evidence", async () => {
    retestRows.mockReturnValue([{ not_before_at: hourAgo(), recommended_at: hourAgo(), scheduled_start_at: null }]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    await createOpeningAttemptService(sql).submit(scope, ATTEMPT, { ...body, retestId: RETEST });
    expect(insertObservation).toHaveBeenCalledWith(scope, expect.objectContaining({ retestId: RETEST, assistance: "independent", nodeId: NODE }), { autoGrade: { enabled: true, modelAvailable: true, dailyCap: 50 }, workSource: undefined });
  });

  it("client claims independent but a hint was delivered: stored as hinted, no skill evidence", async () => {
    exposures.mockResolvedValue(["hinted"]);
    retestRows.mockReturnValue([{ not_before_at: hourAgo(), recommended_at: hourAgo(), scheduled_start_at: null }]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    await createOpeningAttemptService(sql).submit(scope, ATTEMPT, { ...body, retestId: RETEST });
    const saved = insertObservation.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(saved.assistance).toBe("hinted");
    expect(saved.nodeId).toBeUndefined();
  });

  it("early retest-linked submit is rejected server-side (client clock is not trusted)", async () => {
    retestRows.mockReturnValue([{ not_before_at: inHour(), recommended_at: inHour(), scheduled_start_at: null }]);
    const { createOpeningAttemptService } = await import("./attempt-service");
    await expect(createOpeningAttemptService(sql).submit(scope, ATTEMPT, { ...body, retestId: RETEST }))
      .rejects.toBeInstanceOf(RetestSubmitTooEarlyError);
    expect(insertObservation).not.toHaveBeenCalled();
  });

  it("voluntary early practice (no retestId) is saved but carries no retest link or skill evidence", async () => {
    const { createOpeningAttemptService } = await import("./attempt-service");
    await createOpeningAttemptService(sql).submit(scope, ATTEMPT, body);
    const saved = insertObservation.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(saved.retestId).toBeUndefined();
    expect(saved.nodeId).toBeUndefined();
    expect(retestRows).not.toHaveBeenCalled();
  });
});
