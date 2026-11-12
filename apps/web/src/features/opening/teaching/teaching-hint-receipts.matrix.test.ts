import { describe, expect, it, vi } from "vitest";
import { readReleasedTeachingHints, requestTeachingHint } from "./teaching-hint-client";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const attempt = { id, courseId: id, itemVersionId: null };
const context = { activityId: id, blockId: id, contentVersion: 3 };
function hint(level: 1 | 2 | 3 | 4) {
  return { attemptId: id, level, text: `stored stage ${level}`, referenceSourceId: level === 4 ? id : null,
    exposureReceipt: { id, releaseKey: `teaching-hint-v1:${id}:${level}`,
      contextAnchor: { ...context, courseId: id, attemptId: id, itemVersionId: null, purpose: level === 4 ? "history_solution" : "learning_help" },
      origin: level === 4 ? "history_solution" : "assistant", supportDomain: "unknown",
      generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: 1 } };
}
// In-memory Response objects and injected fetch double only; no HTTP/browser.
describe("stored help receipt recovery boundaries", () => {
  it.each([1, 2, 3, 4] as const)("accepts stored stage %s without fabricating an ACK", async level => {
    const body = hint(level), fetcher = vi.fn().mockResolvedValue(Response.json({ hints: [body] }));
    expect(await readReleasedTeachingHints(attempt, context, fetcher)).toEqual([body]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/opening/teaching/hint?attemptId=${id}`, { cache: "no-store" });
  });
  const anchorPatches = [
    { label: "foreign course", patch: { courseId: other } },
    { label: "foreign attempt", patch: { attemptId: other } },
    { label: "foreign activity", patch: { activityId: other } },
    { label: "foreign block", patch: { blockId: other } },
    { label: "foreign item", patch: { itemVersionId: other } },
    { label: "stale content", patch: { contentVersion: 2 } },
    { label: "boolean content version", patch: { contentVersion: true } },
    { label: "null content version", patch: { contentVersion: null } },
    { label: "boolean attempt", patch: { attemptId: false } },
    { label: "null attempt", patch: { attemptId: null } },
  ];
  it.each(anchorPatches.flatMap(p => (["request", "recover"] as const).map(mode => ({ ...p, mode }))))(
    "$mode rejects $label without a delivery/ACK follow-up", async ({ patch, mode }) => {
      const body = hint(1);
      Object.assign(body.exposureReceipt.contextAnchor, patch);
      const fetcher = vi.fn().mockResolvedValue(Response.json(mode === "request" ? body : { hints: [body] }));
      if (mode === "request") await expect(requestTeachingHint(attempt, context, 1, fetcher)).rejects.toThrow();
      else await expect(readReleasedTeachingHints(attempt, context, fetcher)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    });
  it.each([
    { label: "unreleased", patch: { releasedAt: null } },
    { label: "boolean released", patch: { releasedAt: true } },
    { label: "wrong receipt key", patch: { releaseKey: `teaching-hint-v1:${other}:1` } },
    { label: "wrong origin", patch: { origin: "history_solution" } },
    { label: "language support", patch: { supportDomain: "language" } },
    { label: "boolean ACK", patch: { acknowledgedAt: false } },
  ])("recovery refuses $label", async ({ patch }) => {
    const body = hint(1); Object.assign(body.exposureReceipt, patch);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ hints: [body] }));
    await expect(readReleasedTeachingHints(attempt, context, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3, 4] as const)("rejects duplicate stored stage %s rather than displaying extra evidence", async level => {
    const body = hint(level), fetcher = vi.fn().mockResolvedValue(Response.json({ hints: [body, body] }));
    await expect(readReleasedTeachingHints(attempt, context, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("sorts the four saved stages without changing their original receipts", async () => {
    const bodies = [hint(4), hint(2), hint(1), hint(3)];
    const fetcher = vi.fn().mockResolvedValue(Response.json({ hints: bodies }));
    expect(await readReleasedTeachingHints(attempt, context, fetcher)).toEqual([bodies[2], bodies[1], bodies[3], bodies[0]]);
    expect(bodies.map(h => h.level)).toEqual([4, 2, 1, 3]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
