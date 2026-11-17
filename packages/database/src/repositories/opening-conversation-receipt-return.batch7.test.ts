import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningConversationRepository } from "./opening-conversations";
const ports = vi.hoisted(() => ({ release: vi.fn(), lock: vi.fn() }));
vi.mock("./opening-study-exposure", async original => ({ ...await original<typeof import("./opening-study-exposure")>(), releaseOpeningStudyExposure: ports.release }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(), lockWorkspaceLearningHistory: ports.lock }));
const workspace = "11000000-0000-4000-8000-000000000001", owner = "11000000-0000-4000-8000-000000000002";
const conversation = "11000000-0000-4000-8000-000000000003", time = "2026-11-10T00:00:00.000Z";
const scope = { workspaceId: workspace, ownerUserId: owner };
const receiptRow = (id: string, releasedAt: string | null = null) => ({ id, release_key: `release-${id}`, context_anchor: { purpose: "learning_help" }, exposure_origin: "assistant",
  support_domain: "unknown", generated_at: time, released_at: releasedAt, acknowledged_at: null, history_revision: releasedAt ? 4 : 0 });
const turn = (id: string, role: string, status: string, receipt: ReturnType<typeof receiptRow> | null = null) => ({
  id, conversation_id: conversation, role, status, text: `text-${id}`, citations: [], created_at: time, mode: "hint", context_anchor: null,
  exposure_receipt: receipt, system_query: null, job_status: "succeeded", job_error: null,
});
function fixture(rows: ReturnType<typeof turn>[], options: { ownerMissing?: boolean; turnsFailure?: Error; beginFailure?: Error } = {}) {
  let beginCount = 0; const queryCalls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();
    // Fragment construction is inert; actual SQL rows are preset, not a SQL evaluator.
    if (!sql.trim()) return "fragment";
    if (!sql.includes("SELECT") || sql.startsWith("EXISTS") || sql.startsWith("NOT EXISTS") || sql.startsWith("CASE")) return "fragment";
    queryCalls.push({ sql, values });
    if (sql.includes("SELECT id, title, course_id")) return Promise.resolve(options.ownerMissing ? [] : [{ id: conversation, title: "fixture", course_id: null, updated_at: time }]);
    if (sql.includes("FROM opening_turns t")) return options.turnsFailure ? Promise.reject(options.turnsFailure) : Promise.resolve(rows);
    throw new Error(`Unsupported fixture query: ${sql}`);
  });
  const tx = vi.fn();
  const sql = Object.assign(query, { unsafe: () => "fragment", begin: async (fn: (tx: unknown) => Promise<unknown>) => { beginCount++; if (options.beginFailure) throw options.beginFailure; return fn(tx); } });
  return { repo: createOpeningConversationRepository(sql as unknown as Sql), sql, tx, queryCalls, get beginCount() { return beginCount; } };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, bad) => { resolve = ok; reject = bad; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.resetAllMocks(); ports.lock.mockResolvedValue(undefined);
  ports.release.mockImplementation(async (_tx, _scope, id: string) => ({ id, releaseKey: `release-${id}`, contextAnchor: { purpose: "learning_help" },
    origin: "assistant", supportDomain: "unknown", hintStage: null, initiatedBy: null, helpInputSnapshot: null,
    generatedAt: time, releasedAt: time, acknowledgedAt: null, historyRevision: 4 })); });

describe("returned tutor turns release only actual pending assistant exposure receipts", () => {
  it("releases each pending complete assistant receipt, retains released receipts and never releases user or incomplete rows", async () => {
    const rows = [turn("user", "user", "complete", receiptRow("u")), turn("pending", "assistant", "pending", receiptRow("p")),
      turn("failed", "assistant", "failed", receiptRow("f")), turn("complete-a", "assistant", "complete", receiptRow("a")),
      turn("complete-b", "assistant", "complete", receiptRow("b")), turn("prior", "assistant", "complete", receiptRow("prior", time)),
      turn("no-receipt", "assistant", "complete")];
    const f = fixture(rows); const out = await f.repo.listTurns(scope, conversation);
    expect(ports.lock).toHaveBeenCalledExactlyOnceWith(f.tx, scope);
    expect(ports.release.mock.calls).toEqual([[f.tx, scope, "a"], [f.tx, scope, "b"]]);
    expect(f.beginCount).toBe(1);
    expect(out.find(r => r.id === "complete-a")?.exposureReceipt).toMatchObject({ id: "a", releasedAt: time, historyRevision: 4 });
    expect(out.find(r => r.id === "prior")?.exposureReceipt).toMatchObject({ id: "prior", releasedAt: time, historyRevision: 4 });
    expect(out.find(r => r.id === "no-receipt")).not.toHaveProperty("exposureReceipt");
  });
  it("awaits receipt release before returning complete assistant content", async () => {
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a"))]);
    const gate = deferred<unknown>(); ports.release.mockReturnValueOnce(gate.promise);
    let returned = false;
    const call = f.repo.listTurns(scope, conversation).then(value => { returned = true; return value; });
    const settled = call.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await vi.waitFor(() => expect(ports.release).toHaveBeenCalledOnce());
      expect(returned).toBe(false);
    } finally {
      gate.resolve({ id: "a", releaseKey: "release-a", contextAnchor: { purpose: "learning_help" }, origin: "assistant", supportDomain: "unknown", generatedAt: time, releasedAt: time, acknowledgedAt: null, historyRevision: 4 });
      await settled;
    }
    expect((await call)[0]).toMatchObject({ text: "text-a", exposureReceipt: { id: "a", releasedAt: time } });
  });
  it("propagates a release failure instead of returning the corresponding content or releasing later rows", async () => {
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a")), turn("b", "assistant", "complete", receiptRow("b"))]);
    const failure = new Error("synthetic release failure"); ports.release.mockRejectedValueOnce(failure);
    await expect(f.repo.listTurns(scope, conversation)).rejects.toBe(failure);
    expect(ports.release).toHaveBeenCalledOnce(); expect(ports.release).toHaveBeenCalledWith(f.tx, scope, "a");
  });
  it("reuses the prior release on a later read instead of releasing the same receipt again", async () => {
    const rows = [turn("a", "assistant", "complete", receiptRow("a"))]; const f = fixture(rows);
    const first = await f.repo.listTurns(scope, conversation);
    rows[0]!.exposure_receipt = receiptRow("a", time);
    const second = await f.repo.listTurns(scope, conversation);
    expect(second[0]?.exposureReceipt).toEqual(first[0]?.exposureReceipt);
    expect(ports.release).toHaveBeenCalledOnce(); expect(ports.lock).toHaveBeenCalledOnce(); expect(f.beginCount).toBe(1);
  });
  it("does not start a release transaction when all returned receipts are already released or missing", async () => {
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a", time)), turn("b", "assistant", "complete")]);
    expect(await f.repo.listTurns(scope, conversation)).toHaveLength(2);
    expect(f.beginCount).toBe(0); expect(ports.lock).not.toHaveBeenCalled(); expect(ports.release).not.toHaveBeenCalled();
  });
  it("internal continuity routing does not cause a release of pending delivery receipts", async () => {
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a"))]);
    expect(await f.repo.loadContinuityTurns(scope, conversation)).toMatchObject([{ role: "assistant", text: "text-a" }]);
    expect(f.beginCount).toBe(0); expect(ports.lock).not.toHaveBeenCalled(); expect(ports.release).not.toHaveBeenCalled();
  });
  it.each(["owner unavailable", "turn read failure", "transaction unavailable", "history lock unavailable"] as const)("fails closed before releasing content when %s", async boundary => {
    const failure = new Error(`synthetic ${boundary}`);
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a"))], {
      ownerMissing: boundary === "owner unavailable", turnsFailure: boundary === "turn read failure" ? failure : undefined,
      beginFailure: boundary === "transaction unavailable" ? failure : undefined,
    });
    if (boundary === "history lock unavailable") ports.lock.mockRejectedValueOnce(failure);
    const request = f.repo.listTurns(scope, conversation);
    if (boundary === "owner unavailable") await expect(request).rejects.toMatchObject({ code: "NOT_FOUND" });
    else await expect(request).rejects.toBe(failure);
    expect(ports.release).not.toHaveBeenCalled();
    expect(f.beginCount).toBe(boundary === "transaction unavailable" || boundary === "history lock unavailable" ? 1 : 0);
  });
  it("explicit returned-turn delivery is empty for an empty selection and otherwise releases only eligible preset rows", async () => {
    const f = fixture([turn("a", "assistant", "complete", receiptRow("a")), turn("p", "assistant", "pending", receiptRow("p"))]);
    await f.repo.releaseReturnedTurnIds(scope, conversation, []); expect(f.queryCalls).toHaveLength(0);
    await f.repo.releaseReturnedTurnIds(scope, conversation, ["a", "p"]);
    expect(ports.release.mock.calls).toEqual([[f.tx, scope, "a"]]);
    expect(f.beginCount).toBe(1);
  });
});
