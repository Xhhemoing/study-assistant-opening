import { describe, expect, it } from "vitest";
import { backupAssetAdmission, validateBackupWorkspaceAssets } from "./backup-workspace-assets";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const courseId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const excludedId = "00000000-0000-4000-8000-000000000005";
const digest = "a".repeat(64);

const snapshot = { courseId, version: 1, nodes: [], edges: [], coveredSourceVersions: { [sourceId]: 1 } };

function validateGraph(snapshot: Record<string, unknown>, extraRowFields = {}) {
  const graph = {
    workspace_id: workspaceId, owner_user_id: ownerId, course_id: courseId, source_versions: {},
    snapshot, ...extraRowFields,
  };
  const tables = {
    courses: [{ id: courseId }],
    opening_sources: [{ id: sourceId }],
    opening_course_knowledge: [graph],
  };
  const errors: string[] = [];
  validateBackupWorkspaceAssets(tables, errors, ownerId);
  return { admitted: backupAssetAdmission(tables)("opening_course_knowledge", graph), errors };
}

describe("Backup v2 knowledge snapshots", () => {
  it("admits legacy snapshots without chunk digests", () => {
    expect(validateGraph(snapshot)).toEqual({ admitted: true, errors: [] });
  });

  it("admits worker digests for covered sources that did not supply node or edge evidence", () => {
    expect(validateGraph({ ...snapshot, coveredSourceChunkDigests: { [sourceId]: digest } }))
      .toEqual({ admitted: true, errors: [] });
  });

  it("admits parser-backfilled digests on legacy graphs with cited source versions", () => {
    expect(validateGraph({ courseId, version: 1, nodes: [], edges: [], coveredSourceChunkDigests: { [sourceId]: digest } },
      { source_versions: { [sourceId]: 1 } })).toEqual({ admitted: true, errors: [] });
  });

  it("rejects excluded digest sources on a legacy graph", () => {
    expect(validateGraph({ courseId, version: 1, nodes: [], edges: [],
      coveredSourceChunkDigests: { [sourceId]: digest, [excludedId]: digest } },
      { source_versions: { [sourceId]: 1 } }).admitted).toBe(false);
  });

  it.each([
    ["malformed digest", { coveredSourceChunkDigests: { [sourceId]: "not a SHA-256" } }],
    ["admitted source missing from coverage", { coveredSourceVersions: {}, coveredSourceChunkDigests: { [sourceId]: digest } }],
    ["excluded source in coverage", { coveredSourceVersions: { [sourceId]: 1, [excludedId]: 1 } }],
    ["excluded source in both maps", { coveredSourceVersions: { [sourceId]: 1, [excludedId]: 1 },
      coveredSourceChunkDigests: { [sourceId]: digest, [excludedId]: digest } }],
    ["non-source key in the raw digest map", { coveredSourceChunkDigests: { ["__proto__"]: digest } }],
    ["undocumented snapshot field", { node_definitions: { private: "source text" } }],
  ])("rejects %s during export and restore", (_, fields) => {
    expect(validateGraph({ ...snapshot, ...fields })).toEqual({
      admitted: false, errors: ["opening_course_knowledge has an invalid identity, owner or asset reference"],
    });
  });

  it("rejects the private definitions column", () => {
    expect(validateGraph(snapshot, { node_definitions: {} }).admitted).toBe(false);
  });
});
