import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { actionCandidateSchema, type ActionCandidate } from "@aistudy/contracts";
import { createExtractJobCandidateSource, createInMemoryActionCandidateStore, createOpeningActionService } from "./action-service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
function candidate(n: number, patch: Partial<ActionCandidate> = {}): ActionCandidate {
  return actionCandidateSchema.parse({ id: id(n), dedupeKey: `extract-${n}`, title: `Action ${n}`, minutes: 20, dueAt: null,
    priority: 1, sourceIds: [id(80 + n)], status: "pending", needsConfirmation: true, ...patch });
}
function fixture(results: unknown[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim(); calls.push({ sql, values });
    if (!sql.startsWith("SELECT result FROM opening_jobs")) throw new Error(`Unexpected SQL: ${sql}`);
    return results.map(result => ({ result }));
  });
  const extracted = createExtractJobCandidateSource(query as unknown as Sql), store = createInMemoryActionCandidateStore();
  return { calls, extracted, store, service: createOpeningActionService({ store, extracted }) };
}

describe("extracted job result → admitted candidate identity → user action digest", () => {
  it("uses the newest returned legal pending body for one ID, not an older higher-priority duplicate", async () => {
    const latest = candidate(3, { title: "Corrected action", minutes: 15 }), older = candidate(3, { title: "OUTDATED action", priority: 100 });
    const other = candidate(4, { priority: 0 });
    const f = fixture([{ candidates: [latest], telemetry: { ignored: true } }, { candidates: [older, other] }]);
    const digest = await f.service.getDigest(scope);
    expect(digest).toEqual({ primary: [latest, other], pendingConfirmationCount: 2 });
    expect(JSON.stringify(digest)).not.toContain("OUTDATED");
    expect(f.calls).toEqual([{ sql: "SELECT result FROM opening_jobs WHERE workspace_id = ? AND owner_user_id = ? AND kind = 'extract-study-actions' AND state = 'succeeded' AND result IS NOT NULL ORDER BY updated_at DESC LIMIT 20", values: [scope.workspaceId, scope.ownerUserId] }]);
    // Controlled row order plus emitted ORDER BY, not actual PG sorting/authorization proof.
  });
  it("rejects a malformed whole job result instead of salvaging its valid sibling and continues to a later legal job", async () => {
    const poisonSibling = candidate(3, { title: "must not partially surface" }), fallback = candidate(4);
    const f = fixture([{ candidates: [poisonSibling, { ...candidate(5), minutes: 0 }] }, { candidates: [fallback] }]);
    expect(await f.extracted.listPending(scope)).toEqual([fallback]);
    expect(await f.service.getDigest(scope)).toEqual({ primary: [fallback], pendingConfirmationCount: 1 });
    expect(f.calls).toHaveLength(2);
  });
  it("ignores nonpending copies without letting their ID shadow a later pending candidate", async () => {
    const pending = candidate(3), f = fixture([{ candidates: [{ ...pending, status: "accepted", needsConfirmation: false },
      candidate(4, { status: "rejected", needsConfirmation: false }), candidate(5, { status: "superseded", needsConfirmation: false })] }, { candidates: [pending] }]);
    expect(await f.extracted.listPending(scope)).toEqual([pending]);
    expect(await f.service.getDigest(scope)).toEqual({ primary: [pending], pendingConfirmationCount: 1 });
  });
  it("does not lose another candidate from an older job merely because one ID was already seen", async () => {
    const a = candidate(3), b = candidate(4), f = fixture([{ candidates: [a] }, { candidates: [a, b] }]);
    expect(await f.extracted.listPending(scope)).toEqual([a, b]);
    expect((await f.service.getDigest(scope)).primary).toEqual([a, b]);
  });
});
