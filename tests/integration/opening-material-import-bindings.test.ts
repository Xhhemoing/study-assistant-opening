import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningMaterialImportBindingsRepository, createOpeningCourseReadySourcesRepository } from "@aistudy/database";
import { materialImportFixture, importState } from "./opening-material-import-bindings.fixture";

let sql: Sql;
beforeAll(() => {
  if (process.env.PRIVATE_IMPORT_PG_SOCKET) {
    sql = postgres({ host: path.resolve(process.env.PRIVATE_IMPORT_PG_SOCKET), port: 56423, user: "agent", database: "aistudy_opening_test", max: 8 });
  } else {
    const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
    sql = postgres(url.toString(), { max: 8 });
  }
});
afterAll(async () => { await sql?.end(); });
const repo = () => createOpeningMaterialImportBindingsRepository(sql);

it("persists actual reviewer/time, hashes, locators and history atomically; exact replay has the same receipt", async () => {
  const x = await materialImportFixture(sql);
  const first = await repo().accept(x.scope, x.selection, x.input);
  expect(first).toMatchObject({ mappingId: x.input.mappingId, manifestRevision: 1, sourceSha256: x.input.sourceSha256, duplicate: false });
  const before = await importState(sql, x.sourceId, x.scope);
  expect(Number(before.history[0]!.revision)).toBe(1);
  expect(before.versions[0]).toMatchObject({ material_manifest_revision: 1, material_reviewed_by: x.scope.ownerUserId });
  expect(before.versions[0]!.material_reviewed_at.toISOString()).toBe(first.reviewedAt);
  expect(await repo().accept(x.scope, x.selection, x.input)).toEqual({ ...first, duplicate: true });
  expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  const read = await repo().readCurrent(x.scope, x.selector);
  expect(read).toMatchObject({ availability: "available", binding: { reviewedBy: x.scope.ownerUserId,
    input: { answer: { content: { text: "2" } } } } });
  expect(first).not.toHaveProperty("answer");
});

it("same mapping different payload, stale CAS and replay after a later revision conflict without overwrite", async () => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  const before = await importState(sql, x.sourceId, x.scope);
  await expect(repo().accept(x.scope, x.selection, { ...x.input, questionId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().accept(x.scope, x.selection, { ...x.input, mappingId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  await repo().accept(x.scope, x.selection, { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 });
  await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("parallel identical imports share one receipt, one revision and one history fact", async () => {
  const x = await materialImportFixture(sql);
  const receipts = await Promise.all([repo().accept(x.scope, x.selection, x.input), repo().accept(x.scope, x.selection, x.input)]);
  expect(receipts.map(r => r.duplicate).sort()).toEqual([false, true]);
  expect(receipts[0]).toEqual({ ...receipts[1], duplicate: receipts[0]!.duplicate });
  expect(Number((await importState(sql, x.sourceId, x.scope)).history[0]!.revision)).toBe(1);
});

it("parallel competing CAS payloads accept exactly one and never overwrite", async () => {
  const x = await materialImportFixture(sql);
  const results = await Promise.allSettled([repo().accept(x.scope, x.selection, x.input),
    repo().accept(x.scope, x.selection, { ...x.input, mappingId: randomUUID() })]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
  expect((await importState(sql, x.sourceId, x.scope)).versions[0]!.material_manifest.bindings).toHaveLength(1);
});

it.each(["workspace", "owner", "course", "source"] as const)("rejects cross-%s identity, not caller assertions", async field => {
  const x = await materialImportFixture(sql), foreign = await materialImportFixture(sql);
  const scope = field === "workspace" ? { ...x.scope, workspaceId: foreign.scope.workspaceId }
    : field === "owner" ? { ...x.scope, ownerUserId: foreign.scope.ownerUserId } : x.scope;
  const selection = field === "course" ? { ...x.selection, courseId: foreign.course.id } : x.selection;
  const input = field === "source" ? { ...foreign.input } : x.input;
  await expect(repo().accept(scope, selection, input)).rejects.toHaveProperty("code");
  expect((await importState(sql, x.sourceId, x.scope)).versions).toHaveLength(0);
});

it.each(["reviewedBy", "ownerUserId", "grant"])("strict input rejects forged %s", async key => {
  const x = await materialImportFixture(sql);
  await expect(repo().accept(x.scope, x.selection, { ...x.input, [key]: x.scope.ownerUserId })).rejects.toThrow();
  expect((await importState(sql, x.sourceId, x.scope)).versions).toHaveLength(0);
});

it.each(["sha", "chunk", "page", "range", "contentSha", "role", "version"] as const)("invalid %s rolls back journal/history", async changed => {
  const x = await materialImportFixture(sql), input = structuredClone(x.input);
  if (changed === "sha") {
    input.sourceSha256 = "a".repeat(64); input.question.locator.sourceSha256 = input.sourceSha256; input.answer.locator.sourceSha256 = input.sourceSha256;
  }
  if (changed === "chunk") input.question.locator.chunkId = randomUUID();
  if (changed === "page") Object.assign(input.question.locator, { physicalPage: 1, printedLabel: "1" });
  if (changed === "range") input.question.locator.textRange.end = 800;
  if (changed === "contentSha") Object.assign(input.question, { expectedContentSha256: "a".repeat(64) });
  if (changed === "role") Object.assign(input.answer.content, { role: "solution" });
  if (changed === "version") { input.sourceVersion = 2; input.question.locator.sourceVersion = 2; input.answer.locator.sourceVersion = 2; }
  const before = await importState(sql, x.sourceId, x.scope);
  await expect(repo().accept(x.scope, x.selection, input)).rejects.toThrow();
  expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
});

it.each(["purpose", "reference", "remove", "recreate", "privacy", "version", "sha", "archive", "unavailable", "metadata", "parse", "delete"] as const)(
  "old pin and successful receipt cannot authorize replay/read after current %s revocation", async changed => {
    const x = await materialImportFixture(sql);
    await repo().accept(x.scope, x.selection, x.input);
    if (changed === "purpose" || changed === "reference") await x.courses.updateAssetMembership({ ...x.membershipInput,
      purpose: changed === "purpose" ? "mock_exam" : "reference", expectedUpdatedAt: x.membership.updatedAt.toISOString() });
    if (changed === "remove" || changed === "recreate") {
      await sql`DELETE FROM course_asset_memberships WHERE id=${x.membership.id}`;
      if (changed === "recreate") await x.courses.addAssetMembership({ ...x.membershipInput, purpose: "teaching", role: "core", visibility: "private" });
    }
    if (changed === "privacy") {
      await sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES(${x.scope.workspaceId},${x.sourceId},now())`;
      await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${x.scope.workspaceId}`;
    }
    if (changed === "version") await sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
    if (changed === "sha") await sql`UPDATE opening_sources SET sha256=${"b".repeat(64)} WHERE id=${x.sourceId}`;
    if (changed === "archive") await sql`UPDATE courses SET archived_at=now() WHERE id=${x.course.id}`;
    if (changed === "unavailable") await sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${x.sourceId}`;
    if (changed === "metadata") await sql`UPDATE opening_source_versions SET bytes=bytes+1 WHERE source_id=${x.sourceId}`;
    if (changed === "parse") await sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${x.sourceId}`;
    if (changed === "delete") await sql`DELETE FROM opening_sources WHERE id=${x.sourceId}`;
    const before = await importState(sql, x.sourceId, x.scope);
    await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo().readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  });

it("unavailable retained row before first import is never revived", async () => {
  const x = await materialImportFixture(sql);
  await sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'unavailable' FROM opening_sources WHERE id=${x.sourceId}`;
  const before = await importState(sql, x.sourceId, x.scope);
  await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
});

it("private reader reports missing, rejects unknown persisted schema and changed digest", async () => {
  const x = await materialImportFixture(sql);
  expect(await repo().readCurrent(x.scope, x.selector)).toEqual({ availability: "unavailable", reason: "binding_missing" });
  await repo().accept(x.scope, x.selection, x.input);
  await sql`UPDATE opening_source_versions SET material_manifest=jsonb_set(material_manifest,'{schemaVersion}','999') WHERE source_id=${x.sourceId}`;
  await expect(repo().readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
  await sql`UPDATE opening_source_versions SET material_manifest=jsonb_set(jsonb_set(material_manifest,'{schemaVersion}','1'),
    '{bindings,0,questionContentSha256}',to_jsonb(${'b'.repeat(64)}::text)) WHERE source_id=${x.sourceId}`;
  await expect(repo().readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("SQL failure at manifest UPDATE rolls back journal, history, reviewer and manifest", async () => {
  const x = await materialImportFixture(sql);
  await sql.unsafe(`CREATE FUNCTION synthetic_import_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${x.sourceId}'::uuid THEN RAISE EXCEPTION 'synthetic update failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
  await sql`CREATE TRIGGER synthetic_import_fail BEFORE UPDATE ON opening_source_versions FOR EACH ROW EXECUTE FUNCTION synthetic_import_fail()`;
  const before = await importState(sql, x.sourceId, x.scope);
  try {
    await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "P0001" });
    expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  } finally {
    await sql`DROP TRIGGER synthetic_import_fail ON opening_source_versions`;
    await sql`DROP FUNCTION synthetic_import_fail()`;
  }
  await expect(repo().accept(x.scope, x.selection, x.input)).resolves.toMatchObject({ manifestRevision: 1 });
});

it("current reader holds source, membership, course and version locks to caller transaction end", async () => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  await sql.begin(async tx => {
    expect((await repo().readCurrent(x.scope, x.selector, tx)).availability).toBe("available");
    for (const query of [
      () => sql.begin(other => other`SELECT id FROM opening_sources WHERE id=${x.sourceId} FOR UPDATE NOWAIT`),
      () => sql.begin(other => other`SELECT id FROM course_asset_memberships WHERE id=${x.membership.id} FOR UPDATE NOWAIT`),
      () => sql.begin(other => other`SELECT id FROM courses WHERE id=${x.course.id} FOR UPDATE NOWAIT`),
      () => sql.begin(other => other`SELECT source_id FROM opening_source_versions WHERE source_id=${x.sourceId} FOR UPDATE NOWAIT`),
    ]) await expect(query()).rejects.toMatchObject({ code: "55P03" });
  });
  await expect(sql.begin(other => other`SELECT id FROM course_asset_memberships WHERE id=${x.membership.id} FOR UPDATE NOWAIT`)).resolves.toHaveLength(1);
});

it("old repeatable-read snapshot is historical only; current new write denies committed revocation", async () => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  await expect(sql.begin("isolation level repeatable read", async old => {
    expect((await old`SELECT purpose FROM course_asset_memberships WHERE id=${x.membership.id}`)[0]!.purpose).toBe("teaching");
    await sql`UPDATE course_asset_memberships SET purpose='mock_exam',updated_at=clock_timestamp() WHERE id=${x.membership.id}`;
    expect((await old`SELECT purpose FROM course_asset_memberships WHERE id=${x.membership.id}`)[0]!.purpose).toBe("teaching");
    await expect(repo().readCurrent(x.scope, x.selector, old)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
    // PostgreSQL itself rejects using that old snapshot to lock the changed membership.
    await old`SELECT id FROM course_asset_memberships WHERE id=${x.membership.id} FOR SHARE`;
  })).rejects.toMatchObject({ code: "40001" });
});

it("CAS returning zero rows rolls back the journal and history instead of returning a receipt", async () => {
  const x = await materialImportFixture(sql);
  await sql.unsafe(`CREATE FUNCTION synthetic_import_cas_miss() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${x.sourceId}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await sql`CREATE TRIGGER synthetic_import_cas_miss BEFORE UPDATE ON opening_source_versions FOR EACH ROW EXECUTE FUNCTION synthetic_import_cas_miss()`;
  const before = await importState(sql, x.sourceId, x.scope);
  try {
    await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await importState(sql, x.sourceId, x.scope)).toEqual(before);
  } finally {
    await sql`DROP TRIGGER synthetic_import_cas_miss ON opening_source_versions`;
    await sql`DROP FUNCTION synthetic_import_cas_miss()`;
  }
});

it.each(["standalone", "citation", "empty", "revision"])("rejects %s purpose-pin bypass in the actual transaction", async changed => {
  const x = await materialImportFixture(sql), original = x.selection.purposePin;
  const pin = changed === "standalone" ? { ...original, courseId: null }
    : changed === "citation" ? { ...original, materialUse: "citation" as const }
    : changed === "empty" ? { ...original, sources: [] }
    : { ...original, sources: original.sources.map(source => ({ ...source, purposeRevision: "2020-01-01T00:00:00.000000Z" })) };
  await expect(repo().accept(x.scope, { ...x.selection, purposePin: pin }, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await importState(sql, x.sourceId, x.scope)).versions).toHaveLength(0);
});

it.each(["chunk", "page", "range"])("replay checks current actual %s, not just manifest payload equality", async changed => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  if (changed === "chunk") await sql`DELETE FROM opening_source_chunks WHERE id=${x.input.question.locator.chunkId}`;
  if (changed === "page") await sql`UPDATE opening_source_chunks SET page=5 WHERE id=${x.input.question.locator.chunkId}`;
  if (changed === "range") await sql`UPDATE opening_source_chunks SET text='Q' WHERE id=${x.input.question.locator.chunkId}`;
  await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo().readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("two-connection barrier: source revocation waits for the actual reader transaction, then replay denies", async () => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  let announce!: (pid: number) => void;
  const pidReady = new Promise<number>(resolve => { announce = resolve; });
  let revocation: Promise<unknown> | undefined;
  await sql.begin(async tx => {
    await repo().readCurrent(x.scope, x.selector, tx);
    revocation = sql.begin(async other => {
      const [row] = await other`SELECT pg_backend_pid() AS pid`;
      announce(Number(row!.pid));
      await other`UPDATE opening_sources SET parse_state='failed' WHERE id=${x.sourceId}`;
    });
    const pid = await pidReady;
    // Observe a real lock wait; no timing-based sleep or invented ordering.
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const [row] = await sql`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
      if (row!.blocked) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });
  await revocation;
  await expect(repo().accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
});

it("a purpose pin recaptured after remove/recreate still cannot replay old accepted provenance", async () => {
  const x = await materialImportFixture(sql);
  await repo().accept(x.scope, x.selection, x.input);
  await sql`DELETE FROM course_asset_memberships WHERE id=${x.membership.id}`;
  await x.courses.addAssetMembership({ ...x.membershipInput, purpose: "teaching", role: "core", visibility: "private" });
  const purposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(x.scope,
    { courseId: x.course.id, sourceIds: [x.sourceId], materialUse: "teaching" });
  await expect(repo().accept(x.scope, { ...x.selection, purposePin }, x.input)).rejects.toMatchObject({ code: "CONFLICT" });
});
