import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningMaterialImportBindingsRepository, createMemoryOpeningRestoreObjectPut, executeOpeningRestoreApply } from "@aistudy/database";
import { composeOpeningBackupDraft } from "@aistudy/domain";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { snapshotOpeningRestoreCurrentFacts } from "../../packages/database/src/repositories/opening-restore-current-facts";
import { materialImportFixture, importState } from "./opening-material-import-bindings.fixture";

const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);
describe.skipIf(!enabled)("material import supported backup round trip", () => {
  let trackedWrites: string[] | null = null;
  const sql = postgres(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB).toString(), {
    debug(_connection, query) { if (trackedWrites && /^\s*(INSERT|UPDATE|DELETE)/i.test(query)) trackedWrites.push(query); },
  });
  const repo = createOpeningMaterialImportBindingsRepository(sql);
  afterAll(() => sql.end());
  it.each(["existing", "deleted", "missing_on_target"] as const)("round-trips audit/revision/purpose pins with %s reviewer without trusting restored reviewers", async reviewer => {
    const x = await materialImportFixture(sql);
    await repo.accept(x.scope, x.selection, x.input);
    let historicalReviewer: string | undefined;
    if (reviewer !== "existing") {
      // Historical audit can refer to a deleted account while this namespace is
      // still owned. The FK becomes null; the JSON audit must survive restoration.
      const historical = await materialImportFixture(sql);
      await sql`UPDATE opening_source_versions SET material_reviewed_by=${historical.scope.ownerUserId},
        material_manifest=jsonb_set(material_manifest,'{bindings,0,reviewedBy}',to_jsonb(${historical.scope.ownerUserId}::text)) WHERE source_id=${x.sourceId}`;
      historicalReviewer = historical.scope.ownerUserId;
      if (reviewer === "deleted") await sql`DELETE FROM users WHERE id=${historicalReviewer}`;
    }
    if (reviewer === "existing") {
      await sql`UPDATE opening_source_versions SET material_reviewed_at='2024-02-29T23:59:59.123000Z',
        material_manifest=jsonb_set(material_manifest,'{bindings,0,reviewedAt}','"2024-02-29T23:59:59.12300Z"') WHERE source_id=${x.sourceId}`;
    }
    const original = (await importState(sql, x.sourceId, x.scope)).versions[0]!;
    const records = await readOpeningBackupRecords(sql, x.scope);
    expect(records.tables.opening_source_versions[0]).toMatchObject({ material_manifest: original.material_manifest,
      material_manifest_revision: 1, material_reviewed_by: original.material_reviewed_by });
    expect(new Date(records.tables.opening_source_versions[0]!.material_reviewed_at as string)).toEqual(original.material_reviewed_at);
    expect(records.tables.course_asset_memberships[0]).toMatchObject({ purpose: "teaching", updated_at: x.selection.purposePin.sources[0]!.purposeRevision });
    const bytes = Buffer.from("What is 1 + 1?\n2");
    const archivePath = `objects/${x.sourceId}/v1.bin`;
    const composed = composeOpeningBackupDraft({ records, staging: {
      snapshot: { workspaceId: x.scope.workspaceId, privacyEpoch: records.privacyEpoch, deletionJournal: records.deletionJournal,
        memoryDeletions: records.memoryDeletions, sources: [{ sourceId: x.sourceId, version: 1, bytes: bytes.length, sha256: x.input.sourceSha256 }] },
      objects: [{ sourceId: x.sourceId, archivePath, bytes: bytes.length, sha256: x.input.sourceSha256, actualSha256: x.input.sourceSha256 }],
    } });
    expect(composed).toMatchObject({ ok: true });
    if (!composed.ok) throw new Error(JSON.stringify(composed));
    // A JSON archive boundary, not in-memory identity preservation.
    const backup = JSON.parse(JSON.stringify(composed.backup));
    if (reviewer === "existing") {
      // Equivalent timezone, date rollover and fractional length must preserve
      // the same millisecond instant through the actual JSON/PG restore writer.
      backup.tables.opening_source_versions[0].material_reviewed_at = "2024-03-01T01:59:59.123000+02:00";
    }
    // Only this synthetic namespace is emptied; retained versions deliberately
    // outlive workspaces, so remove its exact test key before the supported restore.
    await sql`DELETE FROM workspaces WHERE id=${x.scope.workspaceId}`;
    await sql`DELETE FROM opening_source_versions WHERE source_id=${x.sourceId}`;
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${x.scope.workspaceId} AND owner_user_id=${x.scope.ownerUserId}`;
    await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${x.scope.workspaceId},${x.scope.ownerUserId})`;
    if (reviewer === "missing_on_target") await sql`DELETE FROM users WHERE id=${historicalReviewer!}`;
    const objectPut = createMemoryOpeningRestoreObjectPut();
    const facts = await snapshotOpeningRestoreCurrentFacts(sql, backup);
    if (reviewer === "existing") {
      for (const drift of ["time", "microtime", "jsonMicrotime", "matchingMicrotime", "jsonPrecision", "invalidCalendar", "history", "revision"] as const) {
        const corrupted = JSON.parse(JSON.stringify(backup));
        const row = corrupted.tables.opening_source_versions[0];
        if (drift === "time") row.material_reviewed_at = "2000-01-01T00:00:00Z";
        if (drift === "microtime") row.material_reviewed_at = "2024-03-01T01:59:59.123001+02:00";
        if (drift === "jsonMicrotime") row.material_manifest.bindings[0].reviewedAt = "2024-02-29T23:59:59.123001Z";
        if (drift === "matchingMicrotime") {
          row.material_reviewed_at = "2024-02-29T23:59:59.123456Z";
          row.material_manifest.bindings[0].reviewedAt = row.material_reviewed_at;
        }
        if (drift === "jsonPrecision") row.material_manifest.bindings[0].reviewedAt = "2024-02-29T23:59:59.1230000Z";
        if (drift === "invalidCalendar") {
          row.material_reviewed_at = "2024-02-30T00:00:00Z";
          row.material_manifest.bindings[0].reviewedAt = row.material_reviewed_at;
        }
        if (drift === "history") row.material_manifest.bindings[0].historyRevision = 9000;
        if (drift === "revision") row.material_manifest_revision = 2;
        const before = await importState(sql, x.sourceId, x.scope);
        const writes: string[] = [];
        trackedWrites = writes;
        let rejected;
        try {
          rejected = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup: corrupted, ...facts,
            objectBodies: { [archivePath]: bytes }, objectPut });
        } finally { trackedWrites = null; }
        expect(rejected).toMatchObject({ ok: false, mutated: false });
        expect(writes).toEqual([]);
        expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
        expect(objectPut.store.size).toBe(0);
        expect(await sql`SELECT id FROM courses WHERE workspace_id=${x.scope.workspaceId}`).toHaveLength(0);
        expect(await sql`SELECT source_id FROM opening_source_versions WHERE source_id=${x.sourceId}`).toHaveLength(0);
      }
    }
    const restored = await executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup, ...facts,
      objectBodies: { [archivePath]: bytes }, objectPut });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, objectsApplied: 1, objectApplyDeferred: false });
    if (!restored.ok) throw new Error(JSON.stringify(restored));
    expect(objectPut.store.get(archivePath)).toEqual(new Uint8Array(bytes));
    const after = (await importState(sql, x.sourceId, x.scope)).versions[0]!;
    expect(after).toMatchObject({ material_manifest_revision: 1, material_reviewed_by: reviewer === "existing" ? x.scope.ownerUserId : null,
      material_reviewed_at: original.material_reviewed_at, material_manifest: { ...original.material_manifest, restoredFromBackup: true } });
    const [membership] = await sql`SELECT purpose,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM course_asset_memberships WHERE id=${x.membership.id}`;
    expect(membership).toMatchObject({ purpose: "teaching", updated_at: x.selection.purposePin.sources[0]!.purposeRevision });
    const [history] = await sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${x.scope.workspaceId}`;
    expect(Number(history!.revision)).toBe(1);
    const code = "CONFLICT";
    await expect(repo.readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code });
    await expect(repo.accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code });
    if (reviewer === "existing") {
      const again = await readOpeningBackupRecords(sql, x.scope);
      expect(again.tables.opening_source_versions[0]!.material_manifest).toEqual(after.material_manifest);
    }
  });
});
