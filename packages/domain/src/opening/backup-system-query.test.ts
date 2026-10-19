import { expect, it } from "vitest";
import { validateBackupSystemQuery } from "./backup-system-query";
const id = "00000000-0000-4000-8000-000000000001", asOf = "2026-10-19T00:00:00Z";
const authorization = { purpose: "system_record_lookup", workspaceId: id, principalId: id, role: "workspace_owner", permissionRevision: "owner-fixture" };
const ref = { sourceId: id, sourceVersion: 1 };
const receipt = { authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read",
  results: [{ authorization, name: "materials", status: "ok", reason: "read", asOf, version: "1", evidence: [], sourceRefs: [ref], nextOffset: null,
    data: [{ id, sourceId: id, sourceVersion: 1, physicalPage: 1, truncated: false, exposure: "content_withheld", summary: "location" }] }] };
const row = { workspace_id: id, query_system: true, role: "assistant", system_query: receipt, context_source_refs: [ref] };
it("restores old ordinary turns and valid query receipts, rejecting incomplete lineage and reclassified/cross-workspace imports", () => {
  expect(validateBackupSystemQuery({ role: "user" })).toEqual([]);
  expect(validateBackupSystemQuery(row)).toEqual([]);
  expect(validateBackupSystemQuery({ ...row, context_source_refs: [] })).toContain("turn query receipt lineage is incomplete");
  for (const change of [{ query_system: false }, { role: "user" }, { workspace_id: "00000000-0000-4000-8000-000000000002" }, { system_query: { ...receipt, extra: true } }]) {
    expect(validateBackupSystemQuery({ ...row, ...change })).toContain("turn query receipt is invalid");
  }
});
