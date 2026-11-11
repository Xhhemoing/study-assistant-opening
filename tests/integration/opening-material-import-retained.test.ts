import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningMaterialImportBindingsRepository } from "@aistudy/database";
import { materialImportFixture, importState } from "./opening-material-import-bindings.fixture";

const enabled = process.env.OPENING_TEST_DB === "1" && Boolean(process.env.OPENING_TEST_DATABASE_URL);
describe.skipIf(!enabled)("material import retained-state boundary", () => {
  const sql = postgres(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB).toString());
  const repo = createOpeningMaterialImportBindingsRepository(sql);
  afterAll(() => sql.end());
  it.each(["read", "replay", "append"] as const)("JSON submillisecond drift denies %s with the entire retained state unchanged", async operation => {
    const x = await materialImportFixture(sql);
    await repo.accept(x.scope, x.selection, x.input);
    // Fix a deterministic millisecond before adding exactly one microsecond in JSON only.
    await sql`UPDATE opening_source_versions SET material_reviewed_at='2024-02-29T23:59:59.123000Z',
      material_manifest=jsonb_set(material_manifest,'{bindings,0,reviewedAt}','"2024-02-29T23:59:59.123001Z"') WHERE source_id=${x.sourceId}`;
    const snapshot = async () => ({
      versions: await sql`SELECT to_jsonb(v) AS row FROM opening_source_versions v WHERE source_id=${x.sourceId} ORDER BY version`,
      history: await sql`SELECT to_jsonb(h) AS row FROM opening_workspace_history_revisions h WHERE workspace_id=${x.scope.workspaceId} ORDER BY owner_user_id`,
    });
    const before = await snapshot();
    const result = operation === "read" ? repo.readCurrent(x.scope, x.selector)
      : repo.accept(x.scope, x.selection, operation === "replay" ? x.input : { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 });
    await expect(result).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
  });
  it("equivalent millisecond fractional padding retains audit across read/replay/append", async () => {
    const x = await materialImportFixture(sql);
    await repo.accept(x.scope, x.selection, x.input);
    await sql`UPDATE opening_source_versions SET material_reviewed_at='2024-02-29T23:59:59.123000Z',
      material_manifest=jsonb_set(material_manifest,'{bindings,0,reviewedAt}','"2024-02-29T23:59:59.12300Z"') WHERE source_id=${x.sourceId}`;
    const before = await importState(sql, x.sourceId, x.scope);
    expect(await repo.readCurrent(x.scope, x.selector)).toMatchObject({ availability: "available", binding: { reviewedAt: "2024-02-29T23:59:59.12300Z" } });
    expect(await repo.accept(x.scope, x.selection, x.input)).toMatchObject({ duplicate: true });
    expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
    expect(await repo.accept(x.scope, x.selection, { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 })).toMatchObject({ manifestRevision: 2 });
    const after = await importState(sql, x.sourceId, x.scope);
    expect(after.versions[0]!.material_manifest.bindings[0]).toEqual(before.versions[0]!.material_manifest.bindings[0]);
  });
  it.each(["reviewer", "time", "history"] as const)("rejects %s drift before a new append without mutation", async drift => {
    const x = await materialImportFixture(sql);
    await repo.accept(x.scope, x.selection, x.input);
    if (drift === "reviewer") {
      const other = await materialImportFixture(sql);
      await sql`UPDATE opening_source_versions SET material_reviewed_by=${other.scope.ownerUserId} WHERE source_id=${x.sourceId}`;
    } else if (drift === "time") {
      await sql`UPDATE opening_source_versions SET material_reviewed_at='2000-01-01T00:00:00Z' WHERE source_id=${x.sourceId}`;
    } else {
      await sql`UPDATE opening_source_versions SET material_manifest=jsonb_set(material_manifest,'{bindings,0,historyRevision}','9000') WHERE source_id=${x.sourceId}`;
    }
    const before = await importState(sql, x.sourceId, x.scope);
    await expect(repo.accept(x.scope, x.selection, { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  });
  it("submillisecond audit drift and active null FK cannot grant current authority", async () => {
    const x = await materialImportFixture(sql);
    await repo.accept(x.scope, x.selection, x.input);
    await sql`UPDATE opening_source_versions SET material_reviewed_at=material_reviewed_at + interval '1 microsecond' WHERE source_id=${x.sourceId}`;
    await expect(repo.readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE opening_source_versions SET material_reviewed_at=material_reviewed_at - interval '1 microsecond',material_reviewed_by=NULL WHERE source_id=${x.sourceId}`;
    await expect(repo.readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("multiple historical bindings keep different audit times and valid history gaps", async () => {
    const x = await materialImportFixture(sql);
    const first = await repo.accept(x.scope, x.selection, x.input);
    // Another learning-semantic write may leave a gap; the fence is not count(bindings).
    await sql`UPDATE opening_workspace_history_revisions SET revision=revision+1 WHERE workspace_id=${x.scope.workspaceId}`;
    await sql`SELECT pg_sleep(0.01)`;
    const secondInput = { ...x.input, mappingId: randomUUID(), questionId: randomUUID(), expectedManifestRevision: 1 };
    const second = await repo.accept(x.scope, x.selection, secondInput);
    expect(second.reviewedAt).not.toBe(first.reviewedAt);
    const old = await repo.readCurrent(x.scope, { ...x.selector, expectedManifestRevision: 2 });
    expect(old.availability).toBe("available");
    if (old.availability === "available") expect(old.binding.reviewedAt).toBe(first.reviewedAt);
    expect(await repo.accept(x.scope, x.selection, secondInput)).toMatchObject({ duplicate: true, manifestRevision: 2 });
    const state = await importState(sql, x.sourceId, x.scope);
    expect(Number(state.history[0]!.revision)).toBe(3);
  });
});
