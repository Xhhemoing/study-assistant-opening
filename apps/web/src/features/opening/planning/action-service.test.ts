import { describe, expect, it, vi } from "vitest";
import type { ActionCandidate, Scope } from "@aistudy/contracts";
import {
  applyDecisionOverlay,
  candidatesFromImportChunks,
  createInMemoryActionCandidateStore,
  createOpeningActionService,
} from "./action-service";

const scope: Scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const src = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const receipt = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function candidate(n: number, overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    id: id(n),
    dedupeKey: `mail-${n}:deadline`,
    title: `作业${n}`,
    minutes: 30,
    dueAt: null,
    priority: n,
    sourceIds: [src(n)],
    status: "pending",
    needsConfirmation: true,
    ...overrides,
  };
}

describe("createOpeningActionService", () => {
  it("builds a digest from stored candidates with primary ≤ 3", async () => {
    const store = createInMemoryActionCandidateStore([
      candidate(1, { priority: 1, dueAt: "2026-09-16T00:00:00.000Z" }),
      candidate(2, { priority: 2, dueAt: "2026-09-15T00:00:00.000Z" }),
      candidate(3, { priority: 3, dueAt: "2026-09-14T00:00:00.000Z" }),
      candidate(4, { priority: 4, dueAt: "2026-09-17T00:00:00.000Z" }),
    ]);
    const service = createOpeningActionService({ store });
    const digest = await service.getDigest(scope);
    expect(digest.primary).toHaveLength(3);
    expect(digest.pendingConfirmationCount).toBe(4);
    expect(digest.primary.map((c) => c.id)).toEqual([id(3), id(2), id(1)]);
  });

  it("consumes extractStudyActionCandidates shape via extracted source", async () => {
    const extractedRows = candidatesFromImportChunks(
      [
        {
          sourceId: src(1),
          receiptId: receipt(1),
          text: "线性代数作业截止 2026-10-22\n请在课程平台提交",
          sentAt: "2026-10-09T02:00:00.000Z",
          channel: "mail",
        },
      ],
      {
        timeZone: "Asia/Shanghai",
        createId: () => id(42),
      },
    );
    expect(extractedRows[0]?.status).toBe("pending");
    const store = createInMemoryActionCandidateStore([]);
    const service = createOpeningActionService({
      store,
      extracted: { listPending: async () => extractedRows },
    });
    const digest = await service.getDigest(scope);
    expect(digest.primary).toHaveLength(1);
    expect(digest.primary[0]?.id).toBe(id(42));
    expect(digest.primary[0]?.status).toBe("pending");
  });

  it("does not re-prompt after reject overlay on extracted candidate", async () => {
    const store = createInMemoryActionCandidateStore([]);
    const service = createOpeningActionService({
      store,
      extracted: { listPending: async () => [candidate(1)] },
    });
    await service.decide(scope, {
      decision: "reject",
      candidateId: id(1),
      clientKey: "reject-key-1",
    });
    const digest = await service.getDigest(scope);
    expect(digest).toEqual({ primary: [], pendingConfirmationCount: 0 });
  });

  it("accept marks candidate without inventing a plan accept", async () => {
    const planAdapter = {
      proposeDeltaDraft: vi.fn(async () => null),
    };
    const store = createInMemoryActionCandidateStore([candidate(1)]);
    const service = createOpeningActionService({ store, planAdapter });
    const result = await service.decide(scope, {
      decision: "accept",
      candidateId: id(1),
      clientKey: "accept-key-1",
    });
    expect(result.candidate.status).toBe("accepted");
    expect(planAdapter.proposeDeltaDraft).not.toHaveBeenCalled();
    expect(result.digest.primary).toEqual([]);
  });

  it("source revision supersedes pending and can request delta-only replan", async () => {
    const draft = {
      id: id(99),
      date: "2026-09-14",
      version: 0,
      status: "draft" as const,
      baseVersion: 1,
      blocks: [],
      unscheduledTaskIds: [],
    };
    const planAdapter = {
      proposeDeltaDraft: vi.fn(async () => draft),
    };
    const store = createInMemoryActionCandidateStore([
      candidate(1, { status: "accepted", needsConfirmation: false, dedupeKey: "mail-1:deadline" }),
      candidate(2, { status: "pending", dedupeKey: "mail-1:deadline" }),
    ]);
    const service = createOpeningActionService({ store, planAdapter });
    const revised = candidate(3, {
      dedupeKey: "mail-1:deadline",
      title: "更正作业",
      needsConfirmation: false,
    });
    const { digest } = await service.reviseSourceCandidate(scope, revised);
    expect(digest.primary.map((c) => c.id)).toEqual([id(3)]);
    expect(digest.primary[0]?.needsConfirmation).toBe(true);

    const delta = await service.proposeDeltaAfterRevision({
      scope,
      date: "2026-09-14",
      previouslyAcceptedTaskIds: [id(1)],
      revisedCandidateTaskIds: [id(1), id(3)],
      clientKey: "delta-key-1",
    });
    expect(planAdapter.proposeDeltaDraft).toHaveBeenCalledWith({
      scope,
      date: "2026-09-14",
      taskIds: [id(3)],
      clientKey: "delta-key-1",
    });
    expect(delta).toEqual(draft);
  });

  it("includes K02 blockers when provided", async () => {
    const store = createInMemoryActionCandidateStore([]);
    const service = createOpeningActionService({
      store,
      blockers: {
        async listBlockers() {
          return [
            {
              id: id(7),
              nodeId: id(8),
              kind: "clarify",
              reason: "先澄清卡点",
              evidenceIds: [src(9)],
              priority: 90,
            },
          ];
        },
      },
    });
    const digest = await service.getDigest(scope);
    expect(digest.primary).toHaveLength(1);
    expect(digest.primary[0]?.dedupeKey).toBe(`k02:${id(8)}:clarify`);
    expect(digest.pendingConfirmationCount).toBe(1);
  });
});

describe("applyDecisionOverlay", () => {
  it("rejects by dedupeKey so later extract replays are not re-prompted", () => {
    const extracted = [candidate(1), candidate(2)];
    const decisions = [candidate(1, { status: "rejected", needsConfirmation: false })];
    const merged = applyDecisionOverlay(extracted, decisions);
    expect(merged.find((c) => c.dedupeKey === "mail-1:deadline")?.status).toBe("rejected");
    expect(merged.find((c) => c.id === id(2))?.status).toBe("pending");
  });
});
