import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { NativeRestorePlan, NativeBackupRecord, RestoreCollection } from "@aistudy/domain";
import { assertRestoreReferences } from "./backup-references";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const childId = "44444444-4444-4444-8444-444444444444";

function plan(steps: Array<[RestoreCollection, NativeBackupRecord[]]>): NativeRestorePlan {
  return { records: { workspaceId }, steps: steps.map(([collection, rows]) => ({
    collection, records: rows.map(row => ({ workspaceId, ...row })),
  })) } as NativeRestorePlan;
}

function database(available: string[] = []) {
  const queries = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // The lookup itself, not an unscoped preflight, must include the target.
    expect(strings.join("?")).toMatch(/workspace_id(?:=|<>)/u);
    expect(values).toContain(workspaceId);
    return available.map(id => ({ id }));
  });
  const sql = ((value: string | TemplateStringsArray, ...values: unknown[]) =>
    typeof value === "string" || Array.isArray(value) && !Object.hasOwn(value, "raw")
      ? value : queries(value as TemplateStringsArray, ...values)) as unknown as Sql;
  return { sql, queries };
}

describe("native restore reference boundary", () => {
  it.each([
    ["blocks", { documentId: targetId }],
    ["revisions", { documentId: targetId }],
    ["memberships", { courseId: targetId, assetType: "document", assetId: childId }],
    ["goals", { courseId: targetId }],
    ["windows", { goalId: targetId }],
    ["explorations", { courseId: targetId }],
    ["promotions", { explorationId: targetId }],
    ["cards", { sourceDocumentId: targetId }],
    ["events", { type: "correction", correctsEventId: targetId }],
  ] as Array<[RestoreCollection, Record<string, unknown>]>)("rejects a missing or foreign %s reference before insertion", async (collection, fields) => {
    const { sql, queries } = database();
    await expect(assertRestoreReferences(sql, plan([[collection, [{ id, ...fields }]]])))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(queries).toHaveBeenCalled();
  });

  it("allows complete forward references in the same restore plan", async () => {
    const { sql, queries } = database();
    await assertRestoreReferences(sql, plan([
      ["memberships", [{ id, courseId: targetId, assetType: "card", assetId: childId }]],
      ["courses", [{ id: targetId }]], ["cards", [{ id: childId }]],
    ]));
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows a reference found inside the target workspace", async () => {
    const { sql } = database([targetId]);
    await expect(assertRestoreReferences(sql, plan([["blocks", [{ id, documentId: targetId }]]])))
      .resolves.toBeUndefined();
  });

  it("rejects forged nested parent identities", async () => {
    const { sql } = database([targetId]);
    await expect(assertRestoreReferences(sql, plan([["explorations", [{
      id, branches: [{ id: childId, explorationId: targetId }],
    }]]]))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects foreign nested branches and promotion sources", async () => {
    const { sql } = database();
    await expect(assertRestoreReferences(sql, plan([["explorations", [{
      id, blocks: [{ id: childId, explorationId: id, branchId: targetId }],
    }]]]))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects duplicate and non-UUID identities", async () => {
    const { sql } = database();
    await expect(assertRestoreReferences(sql, plan([["courses", [{ id }, { id }]]])))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(assertRestoreReferences(sql, plan([["courses", [{ id: "unsafe" }]]])))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("retains broken relations and historical practice ids absent from the native archive", async () => {
    const { sql } = database();
    await expect(assertRestoreReferences(sql, plan([
      ["relations", [{ id, fromType: "document", fromId: targetId, toType: "block", toId: childId }]],
      ["events", [{ id: childId, type: "attempt", contentId: targetId, syllabusPointId: targetId }]],
      ["cards", [{ id: targetId, syllabusPointId: targetId }]],
    ]))).resolves.toBeUndefined();
  });

  it("rejects historical ids resolving to a live foreign entity", async () => {
    const { sql } = database([targetId]);
    await expect(assertRestoreReferences(sql, plan([
      ["events", [{ id, type: "attempt", contentId: targetId }]],
    ]))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
