import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createOpeningMaterialImportBindingsRepository, createOpeningMaterialImportAcceptInTx,
  createOpeningMaterialImportSessionAcceptInTx } from "./opening-material-import-bindings";
import { assertIdentitySessionForWriteInTx, type ServerSessionWriteCredential } from "./identity";
import { lockLearningOwner, lockWorkspaceLearningHistory } from "./opening-learning-facts";

vi.mock("./identity", () => ({ assertIdentitySessionForWriteInTx: vi.fn() }));
vi.mock("./opening-learning-facts", async importOriginal => ({
  ...await importOriginal<typeof import("./opening-learning-facts")>(),
  lockLearningOwner: vi.fn(), lockWorkspaceLearningHistory: vi.fn(),
}));
import { validateRetainedMaterialImportState } from "./opening-material-import-state";

function input() {
  const sourceId = randomUUID(), sourceSha256 = "a".repeat(64);
  const locator = () => ({ sourceId, sourceVersion: 1, sourceSha256, chunkId: randomUUID(), physicalPage: null,
    printedLabel: null, textRange: { start: 0, end: 1 } });
  return { schemaVersion: 1, sourceId, sourceVersion: 1, sourceSha256, expectedManifestRevision: 0,
    mappingId: randomUUID(), questionId: randomUUID(), question: { locator: locator(), content: {
      schemaVersion: 1, contentVersion: 1, stem: "Q", interaction: { kind: "numeric" } } },
    answer: { locator: locator(), content: { schemaVersion: 1, contentVersion: 1, role: "answer_key", text: "A" } },
    manualConfirmation: { method: "manual_transcription", confirmed: true } };
}
function retained(rowTime: unknown, jsonTime: string) {
  const raw = input(), courseId = randomUUID();
  return { material_manifest_revision: 1, material_reviewed_by: scope.ownerUserId, material_reviewed_at: rowTime,
    material_manifest: { schemaVersion: 1, revision: 1, bindings: [{ input: raw, courseId,
      purposePin: { courseId, materialUse: "teaching", sources: [{ sourceId: raw.sourceId, sourceVersion: 1,
        membershipId: randomUUID(), purpose: "teaching", purposeRevision: "historical-pin" }] },
      questionContentSha256: "a".repeat(64), answerContentSha256: "b".repeat(64), acceptedFromRevision: 0,
      acceptedRevision: 1, reviewedBy: scope.ownerUserId, reviewedAt: jsonTime, historyRevision: 1 }] } };
}
const scope = { ownerUserId: randomUUID(), workspaceId: randomUUID() };
const selection = { courseId: randomUUID(), purposePin: { courseId: null, materialUse: "teaching" as const, sources: [] } };

describe("retained audit instant precision", () => {
  it.each([
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000000Z"],
    ["2024-02-29T23:59:59.1Z", "2024-02-29T23:59:59.100000Z"],
    ["2024-02-29T23:59:59.123000Z", "2024-02-29T23:59:59.123Z"],
    ["2024-02-29T23:59:59.1230Z", "2024-02-29T23:59:59.123000Z"],
    ["2024-02-29T23:59:59.12300Z", "2024-02-29T23:59:59.123000Z"],
    ["2024-03-01T01:59:59.123000+02:00", "2024-02-29T23:59:59.123Z"],
    ["2024-02-29T18:29:59.123000-05:30", "2024-02-29T23:59:59.123Z"],
    ["0099-01-01T00:00:00Z", "0099-01-01T00:00:00.000000Z"],
    [new Date("2024-02-29T23:59:59.123Z"), "2024-02-29T23:59:59.123000Z"],
  ])("compares supported equivalent instants without changing audit: %s / %s", (rowTime, jsonTime) => {
    const row = retained(rowTime, jsonTime), before = structuredClone(row);
    const sourceId = row.material_manifest.bindings[0]!.input.sourceId;
    expect(validateRetainedMaterialImportState(row, sourceId, 1, 1)).toEqual(row.material_manifest);
    expect(row).toEqual(before);
  });
  it.each([
    ["2024-02-29T23:59:59.123000Z", "2024-02-29T23:59:59.123001Z"],
    ["2024-02-29T23:59:59.123456Z", "2024-02-29T23:59:59.123456Z"],
    ["2024-02-29T23:59:59.1234Z", "2024-02-29T23:59:59.123400Z"],
    ["2024-03-01T01:59:59.123001+02:00", "2024-02-29T23:59:59.123000Z"],
    ["2024-02-29T23:59:59.1234567Z", "2024-02-29T23:59:59.123456Z"],
    ["2024-02-29T23:59:59.123456Z", "2024-02-29T23:59:59.1234560Z"],
    ["2023-02-29T00:00:00Z", "2023-03-01T00:00:00Z"],
    ["2024-02-30T00:00:00Z", "2024-02-30T00:00:00Z"],
    ["2024-02-29T24:00:00Z", "2024-03-01T00:00:00Z"],
    ["2024-02-29T23:59:60Z", "2024-02-29T23:59:60Z"],
    ["2024-02-29T23:59:59+24:00", "2024-02-29T23:59:59Z"],
    ["2024-02-29T23:59:59+00:60", "2024-02-29T23:59:59Z"],
    ["not-a-time", "2024-02-29T23:59:59Z"],
    [new Date(NaN), "2024-02-29T23:59:59Z"],
    ["2024-02-29T23:59:59Z", "2024-03-01T01:59:59+02:00"],
  ])("rejects drift/unsupported syntax or precision unchanged: %s / %s", (rowTime, jsonTime) => {
    const row = retained(rowTime, jsonTime), before = structuredClone(row);
    const sourceId = row.material_manifest.bindings[0]!.input.sourceId;
    expect(() => validateRetainedMaterialImportState(row, sourceId, 1, 1)).toThrow();
    expect(row).toEqual(before);
  });
});

describe("source-only transaction seams", () => {
  const credential: ServerSessionWriteCredential = { userId: scope.ownerUserId, workspaceId: scope.workspaceId,
    sessionId: randomUUID(), tokenHash: "synthetic", jwtExpiresAtSeconds: 4_000_000_000 };
  function harness() {
    vi.mocked(assertIdentitySessionForWriteInTx).mockReset();
    vi.mocked(lockLearningOwner).mockReset();
    vi.mocked(lockWorkspaceLearningHistory).mockReset();
    const begin = vi.fn();
    const sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
    // Unit double only; actual TransactionSql and isolation are exercised on PG.
    const query = vi.fn().mockResolvedValue([{ transaction_isolation: "read committed" }]);
    return { sql, begin, query, tx: query as unknown as TransactionSql };
  }
  it("keeps exactly the old runtime facade and begins RC only after valid preparation", async () => {
    const { sql, begin } = harness(), receipt = { synthetic: "begin result" };
    begin.mockResolvedValue(receipt);
    const repo = createOpeningMaterialImportBindingsRepository(sql);
    expect(Object.keys(repo).sort()).toEqual(["accept", "readCurrent"]);
    expect(await repo.accept(scope, selection, input())).toBe(receipt);
    expect(begin).toHaveBeenCalledExactlyOnceWith("isolation level read committed", expect.any(Function));
  });
  it("low-level prepares without beginning, and preserves native SQL errors by identity", async () => {
    const { sql, begin, query, tx } = harness();
    const error = Object.assign(new Error("native"), { code: "55P03" });
    query.mockRejectedValue(error);
    await expect(createOpeningMaterialImportAcceptInTx(sql)(tx, scope, selection, input())).rejects.toBe(error);
    expect(begin).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("low-level malformed/hash-mismatch input fails before touching tx", async () => {
    const { sql, begin, query, tx } = harness(), accept = createOpeningMaterialImportAcceptInTx(sql);
    await expect(accept(tx, scope, selection, { ...input(), grant: true })).rejects.toThrow();
    const raw = input(); Object.assign(raw.answer, { expectedContentSha256: "b".repeat(64) });
    await expect(accept(tx, scope, selection, raw)).rejects.toThrow("SHA-256 mismatch");
    expect(query).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  });
  it("session seam derives only credential scope and orders history, owner, first auth before preparation", async () => {
    const { sql, begin, tx } = harness(), events: string[] = [];
    vi.mocked(lockWorkspaceLearningHistory).mockImplementation(async (_tx, localScope) => {
      events.push("history"); expect(localScope).toEqual(scope); expect(_tx).toBe(tx);
    });
    vi.mocked(lockLearningOwner).mockImplementation(async () => { events.push("owner"); });
    vi.mocked(assertIdentitySessionForWriteInTx).mockImplementation(async (_tx, local) => {
      events.push("auth"); expect(local).toEqual(credential); expect(local).not.toBe(credential);
    });
    await expect(createOpeningMaterialImportSessionAcceptInTx(sql)(tx, credential, selection, {})).rejects.toThrow();
    expect(events).toEqual(["history", "owner", "auth"]); expect(begin).not.toHaveBeenCalled();
  });
  it.each(["repeatable read", "serializable"])("session refuses %s before history writes", async isolation => {
    const { sql, tx, query, begin } = harness();
    query.mockResolvedValue([{ transaction_isolation: isolation }]);
    await expect(createOpeningMaterialImportSessionAcceptInTx(sql)(tx, credential, selection, input())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(lockWorkspaceLearningHistory).not.toHaveBeenCalled();
    expect(assertIdentitySessionForWriteInTx).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  });
  it("first auth native failure escapes without append or retry", async () => {
    const { sql, tx, begin, query } = harness();
    const error = Object.assign(new Error("serialization"), { code: "40001" });
    vi.mocked(assertIdentitySessionForWriteInTx).mockRejectedValue(error);
    await expect(createOpeningMaterialImportSessionAcceptInTx(sql)(tx, credential, selection, input())).rejects.toBe(error);
    expect(assertIdentitySessionForWriteInTx).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
  });
});

describe("import repository input boundary", () => {
  it.each(["ownerUserId", "reviewedBy", "reviewedAt", "eligible", "firstAnswerDto"])("rejects caller %s before opening a transaction", async key => {
    const begin = vi.fn(), sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
    await expect(createOpeningMaterialImportBindingsRepository(sql).accept(scope, selection, { ...input(), [key]: true })).rejects.toThrow();
    expect(begin).not.toHaveBeenCalled();
  });
  it("computes real content SHA before DB and rejects a false expectation", async () => {
    const begin = vi.fn(), sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
    const raw = input(); Object.assign(raw.question, { expectedContentSha256: "b".repeat(64) });
    await expect(createOpeningMaterialImportBindingsRepository(sql).accept(scope, selection, raw)).rejects.toThrow("SHA-256 mismatch");
    expect(begin).not.toHaveBeenCalled();
  });
  it("PM R2 dependency interaction: non-index array own property is rejected before a DB transaction", async () => {
    const begin = vi.fn(), sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
    const raw = input();
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    Object.defineProperty(options, "4294967295", { value: { eligible: true }, enumerable: true });
    Object.assign(raw.question.content, { interaction: { kind: "choice", options } });
    await expect(createOpeningMaterialImportBindingsRepository(sql).accept(scope, selection, raw)).rejects.toThrow();
    expect(begin).not.toHaveBeenCalled();
  });
  it("propagates serialization failure exactly once; no retry or fake receipt", async () => {
    const error = Object.assign(new Error("serialization failure"), { code: "40001" });
    const begin = vi.fn().mockRejectedValue(error), sql = Object.assign(vi.fn(), { begin }) as unknown as Sql;
    await expect(createOpeningMaterialImportBindingsRepository(sql).accept(scope, selection, input())).rejects.toBe(error);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0]![0]).toBe("isolation level read committed");
  });
});
