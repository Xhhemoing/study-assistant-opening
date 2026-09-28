import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import type { TaskCreateInput } from "@aistudy/contracts";
import { prepareRetestTask, retestPayloadHash } from "./opening-retest-task";

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
const taskRow = { id: taskId, title: "复习", minutes: 20, due_at: null, priority: 1, status: "pending" };

// Controlled interleaving only. Real PostgreSQL two-connection coverage remains a separate S1 gate.
describe("retest task lock-time replay", () => {
  it("rechecks after the candidate lock when the first lookup missed a concurrent accept", async () => {
    const payload = { kind: "task", accepted: true, taskId, acceptPayloadHash: retestPayloadHash(input) };
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: candidateId, payload }])
      .mockResolvedValueOnce([{ id: candidateId, payload }])
      .mockResolvedValueOnce([taskRow]);
    const result = await prepareRetestTask(query as unknown as TransactionSql, scope, input);
    expect(result).toEqual({ id: taskId, title: "复习", minutes: 20, dueAt: null, priority: 1, status: "pending" });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("still conflicts if the concurrent accept used the same key with different intent", async () => {
    const payload = { kind: "task", accepted: true, taskId, acceptPayloadHash: retestPayloadHash({ ...input, minutes: 30 }) };
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: candidateId, payload }])
      .mockResolvedValueOnce([{ id: candidateId, payload }]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "CONFLICT", message: "clientKey payload differs" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not replay a consumed candidate accepted under another key", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: candidateId, payload: { kind: "task", accepted: true } }])
      .mockResolvedValueOnce([]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "CONFLICT", message: "retest candidate already consumed" });
  });

  it("reports a missing replay reference without querying an empty UUID", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ payload: { acceptPayloadHash: retestPayloadHash(input) } }]);
    await expect(prepareRetestTask(query as unknown as TransactionSql, scope, input))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "replayed retest task missing" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
