import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import { createReviewActions, initialReviewDraft, loadReviewItems, prepareReviewCommand, retainUnconfirmedReviews, type ReviewApi } from "./review-service";
import { reviewItems, type ReviewItem } from "./review-types";
const id = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
const item: ReviewItem = { ref: { origin: "assistant", kind: "task", id }, title: "练习", sourceNames: [], version: 0,
  proposal: { kind: "task", title: "练习", minutes: 20, dueText: "下周" } };
function api(): ReviewApi {
  return { listCandidates: vi.fn(async () => []), listRetestCandidates: vi.fn(async () => []), listSources: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: taskId, title: "练习", minutes: 20, priority: 1, dueAt: null, status: "pending" as const })),
    acceptRetest: vi.fn(async () => ({ taskId, accepted: true as const, scheduled: false as const })),
    decideMemoryCandidate: vi.fn(async () => ({ id, text: "记忆" }) as never),
    discardCandidate: vi.fn(async () => ({ id, status: "discarded" as const })) };
}
describe("review command routing and retry state", () => {
  it("accepts an assistant task with explicit identity and editable fields", async () => {
    const client = api(), actions = createReviewActions(client, () => "key-000001");
    await actions.submit(item, { ...initialReviewDraft(item), title: "更正任务", minutes: "35" }, "accept");
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ candidateRef: item.ref, title: "更正任务", minutes: 35, dueAt: null, dueText: "下周" }));
    expect(client.acceptRetest).not.toHaveBeenCalled();
  });
  it("keeps the same key and submitted intent after an uncertain response", async () => {
    const client = api(), newKey = vi.fn(() => "key-000001");
    vi.mocked(client.createTask).mockRejectedValueOnce(new Error("connection lost"));
    const actions = createReviewActions(client, newKey), draft = initialReviewDraft(item);
    await expect(actions.submit(item, draft, "accept")).rejects.toThrow("connection lost");
    await expect(actions.submit(item, draft, "discard")).rejects.toThrow("上次请求");
    await actions.submit(item, { ...draft, title: "不应覆盖已提交意图" }, "accept");
    expect(vi.mocked(client.createTask).mock.calls[0]).toEqual(vi.mocked(client.createTask).mock.calls[1]);
    expect(newKey).toHaveBeenCalledTimes(1);
    expect(actions.pending(item)).toBeUndefined();
  });
  it("allows correction after a definite validation rejection", async () => {
    const client = api(), actions = createReviewActions(client, () => "key-000001");
    vi.mocked(client.createTask).mockRejectedValueOnce(new OpeningApiError(400, "invalid"));
    await expect(actions.submit(item, initialReviewDraft(item), "accept")).rejects.toThrow("invalid");
    expect(actions.pending(item)).toBeUndefined();
  });
  it("rejects temporary memory without leaking an expiry into its reject command", () => {
    const memory: ReviewItem = { ...item, ref: { origin: "assistant", kind: "memory", id }, proposal: { kind: "memory", text: "临时", temporary: true } };
    expect(prepareReviewCommand(memory, { ...initialReviewDraft(memory), expiresAt: "" }, "discard", "key-000001"))
      .toMatchObject({ kind: "memory", input: { action: "reject", expiresAt: null } });
  });
  it("freezes the temporary-memory expiry across retries", async () => {
    const memory: ReviewItem = { ...item, ref: { origin: "assistant", kind: "memory", id }, proposal: { kind: "memory", text: "临时", temporary: true } };
    const client = api(), actions = createReviewActions(client, () => "key-000001"), draft = initialReviewDraft(memory);
    vi.mocked(client.decideMemoryCandidate).mockRejectedValueOnce(new Error("lost"));
    await expect(actions.submit(memory, draft, "accept")).rejects.toThrow("lost");
    const result = await actions.submit(memory, { ...draft, expiresAt: "2099-01-01T12:00" }, "accept");
    expect(vi.mocked(client.decideMemoryCandidate).mock.calls[0]).toEqual(vi.mocked(client.decideMemoryCandidate).mock.calls[1]);
    expect(result).not.toHaveProperty("disposition");
  });
  it("sends retests to their own accept endpoint and preserves its taskId", async () => {
    const retest: ReviewItem = { ...item, ref: { origin: "retest", kind: "retest", id }, proposal: { kind: "retest", id, courseId: id, skillLabel: "复习", prompt: "再试一次", sourceIds: [], dueAt: "2026-10-01T00:00:00Z", accepted: false } };
    const client = api();
    const outcome = await createReviewActions(client, () => "key-000001").submit(retest, initialReviewDraft(retest), "accept");
    expect(client.acceptRetest).toHaveBeenCalledWith(id, "key-000001");
    expect(client.createTask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "retest", taskId });
    expect(outcome).not.toHaveProperty("disposition");
  });
  it("does not turn a partial read failure into an empty review list", async () => {
    const client = api();
    vi.mocked(client.listRetestCandidates).mockRejectedValue(new Error("unavailable"));
    await expect(loadReviewItems(client)).rejects.toThrow("unavailable");
  });
  it("keeps same UUIDs from different origins distinct", () => {
    const rows = reviewItems([{ id, workspaceId: id, version: 0, candidate: item.proposal as never, sourceIds: [], sourceTurnId: id, status: "pending", createdAt: "2026-09-28T00:00:00Z" }],
      [{ id, courseId: id, skillLabel: "复习", prompt: "再试", sourceIds: [], dueAt: "2026-10-01T00:00:00Z", accepted: false, kind: "task" }], []);
    expect(rows.map((row) => row.ref.origin)).toEqual(["assistant", "retest"]);
  });
});

it("keeps uncertain requests visible after the server list no longer contains the candidate", async () => {
  const client = api(), actions = createReviewActions(client, () => "key-000001");
  vi.mocked(client.createTask).mockRejectedValue(new Error("response lost after commit"));
  await expect(actions.submit(item, initialReviewDraft(item), "accept")).rejects.toThrow("response lost");
  expect(retainUnconfirmedReviews([item], [], actions.pending)).toEqual([item]);
  expect(retainUnconfirmedReviews([item], [item], actions.pending)).toEqual([item]);
  expect(retainUnconfirmedReviews([item], [], () => undefined)).toEqual([]);
});
