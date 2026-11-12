import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { resolveOpeningStudyContext } from "./opening-study-context";
const workspace = "50000000-0000-4000-8000-000000000001", owner = "50000000-0000-4000-8000-000000000002";
const source = "50000000-0000-4000-8000-000000000003", chunk = "50000000-0000-4000-8000-000000000004";
const other = "50000000-0000-4000-8000-000000000005";
const scope = { workspaceId: workspace, ownerUserId: owner };
const normalize = (parts: TemplateStringsArray) => parts.reduce((s, part, i) => s + (i ? `$${i}` : "") + part, "").replace(/\s+/g, " ").trim();
function transport(options: { ownerMissing?: boolean; sourceMissing?: boolean; historicalMissing?: boolean; pageMissing?: boolean;
  chunkMissing?: boolean; chunkVersion?: number; chunkPage?: number; attemptSourceVersion?: number } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalize(parts); calls.push({ sql, values });
    if (sql.startsWith("SELECT id FROM workspaces")) return options.ownerMissing ? [] : [{ id: workspace }];
    if (sql.startsWith("SELECT * FROM opening_learning_attempts")) return [{ id: other, session_id: workspace, course_id: null, activity_id: owner,
      item_version_id: null, create_intent: {}, source_versions: { [source]: options.attemptSourceVersion ?? 1 } }];
    if (sql.startsWith("SELECT * FROM opening_learning_sessions")) return [{ course_id: null, activity_id: owner, source_ids: [source] }];
    if (sql.startsWith("SELECT * FROM opening_teaching_activities")) return [{ course_id: null, source_ids: [source] }];
    if (sql.startsWith("SELECT id,version FROM opening_sources")) return options.sourceMissing ? [] : [{ id: source, version: 3 }];
    if (sql.startsWith("SELECT source_id,source_version,page")) return options.chunkMissing ? [] : [{ source_id: source, source_version: options.chunkVersion ?? 1, page: options.chunkPage ?? 7 }];
    if (sql.startsWith("SELECT version FROM opening_source_versions")) return options.historicalMissing ? [] : [{ version: 1 }];
    if (sql.startsWith("SELECT id FROM opening_source_chunks")) return options.pageMissing ? [] : [{ id: chunk }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query: query as unknown as Sql, calls };
}
// This records resolver reads with preset rows; no SQL engine or authorization proof.
describe("help receipt material access keeps the selected source version and page", () => {
  it.each(["ai", "human_read"] as const)("%s source access emits both parse/privacy choices without inventing a newer version", async sourceAccess => {
    const { query, calls } = transport();
    const selection = { purpose: "learning_help" as const, sourceId: source, sourceVersion: 1, page: 7 };
    const result = await resolveOpeningStudyContext(query, scope, selection, { sourceAccess });
    expect(result).toMatchObject(selection);
    expect(calls[0]).toEqual({ sql: "SELECT id FROM workspaces WHERE id=$1 AND owner_user_id=$2", values: [workspace, owner] });
    const access = calls.find(c => c.sql.startsWith("SELECT id,version"))!;
    expect(access.sql).toBe("SELECT id,version FROM opening_sources WHERE id=$1 AND workspace_id=$2 AND upload_state='uploaded' AND (parse_state='ready' OR $3) AND ($4 OR NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=$5 AND e.source_id=$6)) FOR SHARE");
    expect(access.values).toEqual([source, workspace, sourceAccess === "human_read", sourceAccess === "human_read", workspace, source]);
    expect(calls.find(c => c.sql.startsWith("SELECT version"))).toEqual({ sql: "SELECT version FROM opening_source_versions WHERE source_id=$1 AND workspace_id=$2 AND version=$3 AND availability='available' FOR SHARE", values: [source, workspace, 1] });
    expect(calls.at(-1)).toEqual({ sql: "SELECT id FROM opening_source_chunks WHERE source_id=$1 AND source_version=$2 AND ($3::int IS NULL OR page=$4) LIMIT 1", values: [source, 1, 7, 7] });
  });
  it("uses current source version only when no captured version or chunk was selected", async () => {
    const { query, calls } = transport();
    expect(await resolveOpeningStudyContext(query, scope, { purpose: "material_read", sourceId: source })).toMatchObject({ sourceVersion: 3, page: null });
    expect(calls.some(c => c.sql.startsWith("SELECT version"))).toBe(false);
    expect(calls.at(-1)?.values).toEqual([source, 3, null, null]);
  });
  it("uses the attempt's captured source version when selection omits it, not the currently uploaded version", async () => {
    const { query, calls } = transport({ attemptSourceVersion: 1 });
    expect(await resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: other, sourceId: source })).toMatchObject({
      attemptId: other, sourceId: source, sourceVersion: 1, courseId: null, activityId: owner,
    });
    expect(calls.find(c => c.sql.startsWith("SELECT version"))?.values).toEqual([source, workspace, 1]);
    expect(calls.at(-1)?.values).toEqual([source, 1, null, null]);
  });
  it("binds the selected chunk's saved version/page instead of using current material", async () => {
    const { query, calls } = transport();
    expect(await resolveOpeningStudyContext(query, scope, { purpose: "learning_help", sourceId: source, chunkId: chunk })).toMatchObject({ sourceVersion: 1, page: 7, chunkId: chunk });
    expect(calls.find(c => c.sql.startsWith("SELECT source_id"))).toEqual({ sql: "SELECT source_id,source_version,page FROM opening_source_chunks WHERE id=$1 AND source_id=$2 FOR SHARE", values: [chunk, source] });
    expect(calls.at(-1)?.values).toEqual([source, 1, 7, 7]);
  });
  it.each([
    { label: "unavailable old source version", options: { historicalMissing: true }, message: "selected material version unavailable; no switch to current version" },
    { label: "unreadable selected page", options: { pageMissing: true }, message: "selected material version/page is unavailable" },
    { label: "source absent/excluded", options: { sourceMissing: true }, message: "study material unavailable or excluded" },
  ])("refuses $label rather than repairing the anchor", async ({ options, message }) => {
    const { query } = transport(options);
    await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", sourceId: source, sourceVersion: 1, page: 7 }))
      .rejects.toMatchObject({ code: "CONFLICT", message });
  });
  it.each([
    { label: "source version mismatch", options: { chunkVersion: 2 }, message: "study context sourceVersion mismatch; reopen the selected version" },
    { label: "page mismatch", options: { chunkPage: 8 }, message: "study context page mismatch; reopen the selected version" },
    { label: "chunk not returned for source", options: { chunkMissing: true }, message: "chunk does not belong to selected material" },
  ])("does not overwrite the explicit selection on $label", async ({ options, message }) => {
    const { query, calls } = transport(options);
    await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", sourceId: source, sourceVersion: 1, page: 7, chunkId: chunk }))
      .rejects.toMatchObject({ code: "CONFLICT", message });
    expect(calls.some(c => c.sql.startsWith("SELECT id FROM opening_source_chunks"))).toBe(false);
  });
  it("refuses a source outside the turn's explicit set before reading source content", async () => {
    const { query, calls } = transport();
    await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", sourceId: source }, { sourceIds: [other] }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "anchor material is outside turn source selection" });
    expect(calls).toHaveLength(1);
  });
  it("stops on absent workspace owner before any material lookup", async () => {
    const { query, calls } = transport({ ownerMissing: true });
    await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", sourceId: source })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });
  it("association-only history preserves unknown source version without loading or reclassifying material", async () => {
    const { query, calls } = transport();
    expect(await resolveOpeningStudyContext(query, scope, { purpose: "note_read", sourceId: source }, { associationOnly: true })).toMatchObject({ sourceId: source, sourceVersion: null });
    expect(calls).toHaveLength(1);
  });
});
