import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createOpeningMaterialImportBindingsRepository } from "./opening-material-import-bindings";
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
