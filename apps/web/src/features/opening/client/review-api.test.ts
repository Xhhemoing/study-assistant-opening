import { expect, it, vi } from "vitest";
import { createOpeningApi, OpeningApiError } from "./api";
const id = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
it("posts assistant task edits to tasks with its explicit reference", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ id: taskId, title: "更正任务", minutes: 30, dueAt: null, priority: 2, status: "pending" }, 201));
  const input = { candidateId: id, candidateRef: { origin: "assistant" as const, kind: "task" as const, id }, expectedVersion: 0,
    title: "更正任务", minutes: 30, dueAt: null, priority: 2, clientKey: "same-key-1" };
  expect((await createOpeningApi(fetch as never).createTask(input)).id).toBe(taskId);
  expect(fetch).toHaveBeenCalledWith("/api/opening/tasks", expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
});
it("uses the retest accept response as-is without inventing a disposition", async () => {
  const fetch = vi.fn(async () => json({ taskId, accepted: true, scheduled: false }));
  const result = await createOpeningApi(fetch as never).acceptRetest(id, "same-key-1");
  expect(fetch).toHaveBeenCalledWith(`/api/opening/retests/${id}/accept`, expect.objectContaining({ method: "POST", body: JSON.stringify({ clientKey: "same-key-1" }) }));
  expect(result).not.toHaveProperty("disposition");
});
it.each(["assistant", "retest"] as const)("routes %s ignores by source and sends the joint identity", async (origin) => {
  const fetch = vi.fn(async () => json({ id, status: "discarded" }));
  const ref = origin === "assistant" ? { origin, kind: "task" as const, id } : { origin, kind: "retest" as const, id };
  await createOpeningApi(fetch as never).discardCandidate(ref, "same-key-1");
  expect(fetch).toHaveBeenCalledWith(`/api/opening/${origin === "assistant" ? "candidates" : "retests"}/${id}/discard`, expect.objectContaining({ body: JSON.stringify({ candidateRef: ref, clientKey: "same-key-1" }) }));
});
it("rejects malformed retest responses and keeps read errors distinguishable from an empty list", async () => {
  await expect(createOpeningApi(vi.fn(async () => json({})) as never).listRetestCandidates()).rejects.toThrow();
  await expect(createOpeningApi(vi.fn(async () => json({ error: { code: "UNAUTHENTICATED", message: "login required" } }, 401)) as never).listRetestCandidates()).rejects.toBeInstanceOf(OpeningApiError);
});
