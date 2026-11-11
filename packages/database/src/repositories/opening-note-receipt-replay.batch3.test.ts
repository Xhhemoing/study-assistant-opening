import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningContentDeliveryRepository } from "./opening-content-delivery";
const hooks = vi.hoisted(() => ({ deliver: vi.fn(), generate: vi.fn(), release: vi.fn(), lock: vi.fn() }));
vi.mock("./opening-study-exposure", () => ({ createOpeningStudyExposureRepository: () => ({ deliver: hooks.deliver }), generateOpeningStudyExposure: hooks.generate,
  releaseOpeningStudyExposure: hooks.release, mapOpeningStudyExposure: (row: Record<string, unknown>) => ({ id: row.id }) }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(), lockWorkspaceLearningHistory: hooks.lock }));
const id = "40000000-0000-4000-8000-000000000001", owner = "40000000-0000-4000-8000-000000000002";
const source = "40000000-0000-4000-8000-000000000003";
const scope = { workspaceId: id, ownerUserId: owner };
const ref = { type: "note", id, version: "3" };
function database(existing: Record<string, unknown>[], refs: unknown = null) {
  const calls: Array<{ parts: TemplateStringsArray; values: unknown[] }> = [];
  const tx = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ parts, values }); const sql = parts.join("?");
    if (sql.includes("FROM library_documents")) return [{ id, provenance_id: refs == null ? null : id, context_source_refs: refs }];
    if (sql.includes("FROM opening_help_exposures")) return existing;
    if (sql.includes("FROM opening_learning_attempts")) return [{ id: owner }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const sql = Object.assign(tx, { begin: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) });
  return { sql: sql as unknown as Sql, calls, tx };
}
const saved = (receiptId: string, originReference: unknown) => ({ id: receiptId, release_intent: { originReference } });
beforeEach(() => { vi.clearAllMocks(); hooks.generate.mockImplementation(async (_tx, _scope, input) => ({ id: input.releaseKey }));
  hooks.release.mockImplementation(async (_tx, _scope, receiptId) => ({ id: receiptId }));
  hooks.deliver.mockImplementation(async (_scope, input) => ({ id: input.releaseKey })); });

describe("generic note replay validates every saved receipt target", () => {
  it("normalizes only the server association flag and returns the complete original target set", async () => {
    const rows = [saved(id, ref), saved(owner, { ...ref, possibleOpenAttemptOnly: true })];
    const { sql, calls } = database(rows); const before = structuredClone(rows);
    expect(await createOpeningContentDeliveryRepository(sql).note(scope, "replay-key", { id, currentRevisionNumber: 3 })).toEqual([{ id }, { id: owner }]);
    expect(rows).toEqual(before); expect(hooks.lock).toHaveBeenCalledOnce();
    expect(calls.some(c => c.parts.join("").includes("FROM opening_learning_attempts"))).toBe(false);
    expect(hooks.generate).not.toHaveBeenCalled(); expect(hooks.release).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
    const probe = calls.find(c => c.parts.join("").includes("FROM opening_help_exposures"))!;
    expect(probe.parts.reduce((out, part, i) => out + (i ? `$${i}` : "") + part, "").replace(/\s+/g, " ").trim()).toBe(
      "SELECT * FROM opening_help_exposures WHERE workspace_id=$1 AND owner_user_id=$2 AND (release_key=$3 OR release_key LIKE $4) ORDER BY release_key");
    expect(probe.values).toEqual([id, owner, "replay-key:note:generic", "replay-key:note:generic:target:%"]);
  });
  it.each([
    { label: "later target document", changed: { ...ref, id: owner } },
    { label: "later target revision", changed: { ...ref, version: "4" } },
    { label: "later target origin type", changed: { ...ref, type: "source" } },
    { label: "later target extra lineage", changed: { ...ref, sourceRefs: [{ sourceId: source, sourceVersion: 1 }] } },
    { label: "missing stored reference", changed: undefined },
  ])("refuses $label even if the first saved receipt matches", async ({ changed }) => {
    const { sql, calls } = database([saved(id, ref), saved(owner, changed)]);
    await expect(createOpeningContentDeliveryRepository(sql).note(scope, "replay-key", { id, currentRevisionNumber: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls.some(c => c.parts.join("").includes("FROM opening_learning_attempts"))).toBe(false);
    expect(hooks.generate).not.toHaveBeenCalled(); expect(hooks.release).not.toHaveBeenCalled();
  });
  it("keeps two frozen source versions as separate exact note receipts, not a generic open-attempt batch", async () => {
    const { sql, calls } = database([], [{ sourceId: source, sourceVersion: 0 }, { sourceId: source, sourceVersion: 2 }]);
    expect(await createOpeningContentDeliveryRepository(sql).note(scope, "pinned", { id, currentRevisionNumber: 3 })).toEqual([
      { id: "pinned:note:0" }, { id: "pinned:note:1" },
    ]);
    expect(hooks.deliver.mock.calls.map(c => c[1])).toEqual([0, 2].map((sourceVersion, index) => ({ releaseKey: `pinned:note:${index}`,
      contextAnchor: { purpose: "note_read", sourceId: source, sourceVersion }, origin: "note", originReference: ref,
      kind: "hint", level: "hinted", supportDomain: "unknown" })));
    expect(hooks.generate).not.toHaveBeenCalled(); expect(hooks.lock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
  it.each([{ label: "boolean", refs: false }, { label: "mixed-valid-invalid array", refs: [{ sourceId: source, sourceVersion: 1 }, { sourceId: source, sourceVersion: null }] }])(
    "$label provenance uses conservative generic association rather than partial exact lineage", async ({ refs }) => {
      const { sql } = database([], refs);
      await createOpeningContentDeliveryRepository(sql).note(scope, "unknown", { id, currentRevisionNumber: 3 });
      expect(hooks.deliver).not.toHaveBeenCalled(); expect(hooks.generate).toHaveBeenCalledTimes(2);
      expect(hooks.generate.mock.calls.map(c => c[2].contextAnchor)).toEqual([{ purpose: "note_read" }, { purpose: "note_read", attemptId: owner }]);
      expect(hooks.generate.mock.calls[1]![2].originReference).toEqual({ ...ref, possibleOpenAttemptOnly: true });
    });
  it("does not proceed to open-attempt selection if the workspace history lock fails", async () => {
    const failure = new Error("synthetic lock unavailable"); hooks.lock.mockRejectedValueOnce(failure);
    const { sql, calls } = database([]);
    await expect(createOpeningContentDeliveryRepository(sql).note(scope, "failure", { id, currentRevisionNumber: 3 })).rejects.toBe(failure);
    expect(calls).toHaveLength(1); expect(hooks.generate).not.toHaveBeenCalled(); expect(hooks.release).not.toHaveBeenCalled();
  });
});
