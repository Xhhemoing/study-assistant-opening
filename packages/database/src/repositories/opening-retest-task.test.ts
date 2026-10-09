import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import type { TaskCreateInput } from "@aistudy/contracts";
import { prepareRetestTask, retestPayloadHash } from "./opening-retest-task";
import { lockOpeningRetestReviewCandidate } from "./opening-review-candidates";

vi.mock("./opening-review-candidates", () => ({ lockOpeningRetestReviewCandidate: vi.fn() }));
const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const candidateId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const input: TaskCreateInput = {
  title: "复习", minutes: 20, dueAt: null, priority: 1, candidateId,
  clientKey: "retest-lock-replay", baseVersion: 0,
  inputSnapshot: { kind: "retest", candidateId, heuristic: true },
};
const taskRow = { id: taskId, title: "复习", minutes: 20, due_at: null, priority: 1, status: "pending", version: 4 };
beforeEach(() => {
  vi.mocked(lockOpeningRetestReviewCandidate).mockReset();
  vi.mocked(lockOpeningRetestReviewCandidate).mockResolvedValue({ kind: "task", accepted: true });
});

describe("retest task lock-time replay", () => {
  it("returns a concurrent accept only after locking and admitting its candidate", async () => {
    const payload = { kind: "task", accepted: true, taskId, acceptPayloadHash: retestPayloadHash(input) };
    const query = vi.fn().mockResolvedValueOnce([{ id: candidateId, payload }]).mockResolvedValueOnce([taskRow]);
    const result = await prepareRetestTask(query as unknown as TransactionSql, scope, input);
    expect(result).toEqual({ id: taskId, title: "复习", minutes: 20, dueAt: null, priority: 1, status: "pending", version: 4, retest: null });
    expect(lockOpeningRetestReviewCandidate).toHaveBeenCalledWith(query, scope, candidateId);
    expect(vi.mocked(lockOpeningRetestReviewCandidate).mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]!);
  });

  it("still conflicts if the concurrent accept used the same key with different intent", async () => {
    const payload = { kind: "task", accepted: true, taskId, acceptPayloadHash: retestPayloadHash({ ...input, minutes: 30 }) };
    const query = vi.fn().mockResolvedValueOnce([{ id: candidateId, payload }]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "CONFLICT", message: "clientKey payload differs" });
  });

  it("does not replay a consumed candidate accepted under another key", async () => {
    const query = vi.fn().mockResolvedValueOnce([]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "CONFLICT", message: "retest candidate already consumed" });
  });

  it("reports a missing replay reference without querying an empty UUID", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ payload: { acceptPayloadHash: retestPayloadHash(input) } }]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "replayed retest task missing" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not look up a replay after current admission fails", async () => {
    vi.mocked(lockOpeningRetestReviewCandidate).mockRejectedValue(new Error("source unavailable"));
    const query = vi.fn();
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input)).rejects.toThrow("source unavailable");
    expect(query).not.toHaveBeenCalled();
  });
});
