import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createIdentityRepository, hashSessionToken } from "@aistudy/database";
import { createSessionJwt, readSessionWriteCredential } from "../../apps/web/src/lib/session";
import { createOpeningMaterialImportAcceptInTx, createOpeningMaterialImportBindingsRepository,
  createOpeningMaterialImportSessionAcceptInTx } from "../../packages/database/src/repositories/opening-material-import-bindings";
import { assertIdentitySessionForWriteInTx } from "../../packages/database/src/repositories/identity";
import { lockLearningOwner, lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { materialImportFixture } from "./opening-material-import-bindings.fixture";

// Test-only source composition, not a legal production export or HTTP consumer.
const secret = "synthetic-atomic-source-seam-not-a-production-secret";
let sql: Sql;
const clients: Sql[] = [];
type Fixture = Awaited<ReturnType<typeof fixture>>;
beforeAll(() => { sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} }); });
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.end({ timeout: 5 }))); });
afterAll(async () => { await sql?.end({ timeout: 5 }); });
async function fixture() {
  const x = await materialImportFixture(sql), sessionId = randomUUID();
  const token = await createSessionJwt({ sub: x.scope.ownerUserId, workspaceId: x.scope.workspaceId, sid: sessionId }, secret, 120);
  await createIdentityRepository(sql).createSession({ userId: x.scope.ownerUserId, sessionId,
    tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 120000) });
  const credential = await readSessionWriteCredential(token, secret);
  if (!credential) throw new Error("synthetic verified reader failed");
  return { ...x, token, credential };
}
async function snapshot(db: Sql | TransactionSql, x: Fixture) {
  // JSON preserves PostgreSQL US precision; include SQL audit, counter first-insert,
  // and caller-owned write state, not just a sentinel or JS Date snapshot.
  return {
    versions: await db`SELECT to_jsonb(v) AS row FROM opening_source_versions v WHERE source_id=${x.sourceId} ORDER BY version`,
    history: await db`SELECT to_jsonb(h) AS row FROM opening_workspace_history_revisions h WHERE workspace_id=${x.scope.workspaceId}`,
    session: await db`SELECT to_jsonb(s) AS row FROM sessions s WHERE id=${x.credential.sessionId}`,
  };
}
const accept = (db: Sql, tx: TransactionSql, x: Fixture, raw: unknown = x.input, credential = x.credential) =>
  createOpeningMaterialImportSessionAcceptInTx(db)(tx, credential, x.selection, raw);
async function commit(x: Fixture, raw: unknown = x.input) {
  return sql.begin("isolation level read committed", tx => accept(sql, tx, x, raw));
}
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}
async function connection() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {},
    connection: { statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 } });
  clients.push(client);
  return { sql: client, pid: Number((await client`SELECT pg_backend_pid() AS pid`)[0]!.pid) };
}
async function blocked(writer: number, holder: number) {
  const deadline = Date.now() + 2000;
  do {
    const rows = await sql`SELECT 1 FROM pg_stat_activity a WHERE a.pid=${writer}
      AND ${holder}=ANY(pg_blocking_pids(a.pid))
      AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
    if (rows.length) return;
  } while (Date.now() < deadline);
  throw new Error("expected actual PostgreSQL lock wait");
}
async function trigger(x: Fixture, body: string, operation: () => Promise<void>) {
  const name = `atomic_${randomUUID().replaceAll("-", "")}`;
  // Sequence increments survive rollback, proving actual UPDATE reached the trigger.
  await sql.unsafe(`CREATE SEQUENCE ${name}_seen`);
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id='${x.sourceId}'::uuid THEN PERFORM nextval('${name}_seen'); ${body} END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} AFTER UPDATE ON opening_source_versions FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    await operation();
    expect((await sql.unsafe(`SELECT is_called FROM ${name}_seen`))[0]!.is_called).toBe(true);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${name} ON opening_source_versions`);
    await sql.unsafe(`DROP FUNCTION ${name}()`);
    await sql.unsafe(`DROP SEQUENCE ${name}_seen`);
  }
}

it("V01/V03 reader rejects missing/bad/expired signatures before begin; actual raw-reader chain appends", async () => {
  const x = await fixture();
  let begins = 0;
  for (const raw of [undefined, `${x.token}x`, await createSessionJwt({ sub: x.scope.ownerUserId,
    workspaceId: x.scope.workspaceId, sid: x.credential.sessionId }, secret, -1)]) {
    const c = await readSessionWriteCredential(raw, secret);
    if (c) { begins++; await sql.begin("isolation level read committed", tx => accept(sql, tx, x, x.input, c)); }
    expect(c).toBeNull();
  }
  expect(await readSessionWriteCredential(x.token, "wrong-signature-secret")).toBeNull();
  expect(begins).toBe(0);
  expect(await commit(x)).toMatchObject({ duplicate: false, manifestRevision: 1 });
});

it("V01 actual PG observes exactly one wrapper RC begin and no seam-owned begin", async () => {
  const x = await fixture(), statements: string[] = [];
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, debug: (_id, query) => { statements.push(query); } });
  clients.push(client);
  const repo = createOpeningMaterialImportBindingsRepository(client);
  await repo.accept(x.scope, x.selection, x.input);
  expect(statements.filter(query => /^begin\b/i.test(query))).toEqual(["begin isolation level read committed"]);
  for (const session of [false, true]) {
    statements.length = 0;
    await client.begin("isolation level read committed", tx => session
      ? accept(client, tx, x) : createOpeningMaterialImportAcceptInTx(client)(tx, x.scope, x.selection, x.input));
    expect(statements.filter(query => /^begin\b/i.test(query))).toEqual(["begin isolation level read committed"]);
    expect(statements.some(query => /savepoint/i.test(query))).toBe(false);
  }
});

it.each([false, true])("V04 shared append commit visibility, prior manifest=%s; legacy facade and real hashes preserved", async existing => {
  const x = await fixture(), repo = createOpeningMaterialImportBindingsRepository(sql);
  expect(Object.keys(repo).sort()).toEqual(["accept", "readCurrent"]);
  if (existing) await repo.accept(x.scope, x.selection, x.input);
  const before = await snapshot(sql, x), raw = existing ? { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 } : x.input;
  const result = await sql.begin("isolation level read committed", async tx => {
    const receipt = await accept(sql, tx, x, raw);
    const inside = await snapshot(tx, x);
    expect(inside.versions[0]!.row).toMatchObject({ material_manifest_revision: existing ? 2 : 1, material_reviewed_by: x.scope.ownerUserId });
    expect(Number(inside.history[0]!.row.revision)).toBe(existing ? 2 : 1);
    expect(inside.versions[0]!.row.material_manifest.bindings.at(-1)).toMatchObject({ reviewedBy: x.scope.ownerUserId, reviewedAt: receipt.reviewedAt });
    expect(await snapshot(sql, x)).toEqual(before);
    expect(Object.keys(receipt).sort()).toEqual(["answerContentSha256", "duplicate", "manifestRevision", "mappingId", "questionContentSha256", "reviewedAt", "sourceId", "sourceSha256", "sourceVersion"].sort());
    expect(receipt.questionContentSha256).toMatch(/^[a-f0-9]{64}$/);
    return receipt;
  });
  expect((await snapshot(sql, x)).versions[0]!.row.material_manifest_revision).toBe(result.manifestRevision);
  const committed = await snapshot(sql, x);
  expect(await commit(x, raw)).toEqual({ ...result, duplicate: true });
  expect(await snapshot(sql, x)).toEqual(committed);
});

it("V02 credential A cannot select B course/source/pin; neither scope changes", async () => {
  const a = await fixture(), b = await fixture(), beforeA = await snapshot(sql, a), beforeB = await snapshot(sql, b);
  await expect(sql.begin("isolation level read committed", tx =>
    createOpeningMaterialImportSessionAcceptInTx(sql)(tx, a.credential, b.selection, b.input))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(sql, a)).toEqual(beforeA); expect(await snapshot(sql, b)).toEqual(beforeB);
});

it("V02 explicitly unsafe private low-level composition is NOT an authorization API", async () => {
  const a = await fixture(), b = await fixture();
  await sql.begin("isolation level read committed", async tx => {
    // Deliberately wrong test harness: auth A does NOT confer authority over B.
    await lockWorkspaceLearningHistory(tx, a.scope); await lockLearningOwner(tx, a.scope);
    await assertIdentitySessionForWriteInTx(tx, a.credential);
    const receipt = await createOpeningMaterialImportAcceptInTx(sql)(tx, b.scope, b.selection, b.input);
    expect(receipt).toMatchObject({ manifestRevision: 1 });
    await assertIdentitySessionForWriteInTx(tx, a.credential);
  });
  expect((await snapshot(sql, b)).versions[0]!.row.material_reviewed_by).toBe(b.scope.ownerUserId);
});

it.each(["repeatable read", "serializable"])("V01 actual %s refuses session and low-level before counter insertion", async isolation => {
  const x = await fixture(), before = await snapshot(sql, x);
  for (const session of [true, false]) await expect(sql.begin(`isolation level ${isolation}`, tx => session
    ? accept(sql, tx, x) : createOpeningMaterialImportAcceptInTx(sql)(tx, x.scope, x.selection, x.input))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(sql, x)).toEqual(before);
});

it.each([false, true])("V05 first auth succeeds, actual append then DB expiry final failure rolls back ALL state, prior=%s", async existing => {
  const x = await fixture();
  if (existing) await commit(x);
  const before = await snapshot(sql, x), raw = existing ? { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 } : x.input;
  await trigger(x, `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${x.credential.sessionId}'::uuid;`, async () => {
    await expect(sql.begin("isolation level read committed", async tx => {
      await tx`UPDATE sessions SET last_seen_at='2001-01-01T00:00:00Z' WHERE id=${x.credential.sessionId}`;
      return accept(sql, tx, x, raw);
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await snapshot(sql, x)).toEqual(before);
  });
});

it("V05 JWT expiry after actual append uses fresh final cut (not transaction-start now)", async () => {
  const x = await fixture(), before = await snapshot(sql, x);
  await trigger(x, "PERFORM pg_sleep(0.8);", async () => {
    await expect(sql.begin("isolation level read committed", async tx => {
      const exp = Number((await tx`SELECT extract(epoch FROM clock_timestamp()+interval '0.5 second')::float8 AS exp`)[0]!.exp);
      return accept(sql, tx, x, x.input, { ...x.credential, jwtExpiresAtSeconds: exp });
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await snapshot(sql, x)).toEqual(before);
  });
});

it.each(["40001", "55P03", "40P01", "08006"])("V06 native trigger RAISE %s propagates; callback once; actual append rollback", async code => {
  const x = await fixture(), before = await snapshot(sql, x); let calls = 0;
  await trigger(x, `RAISE EXCEPTION 'synthetic atomic native' USING ERRCODE='${code}';`, async () => {
    await expect(sql.begin("isolation level read committed", tx => { calls++; return accept(sql, tx, x); })).rejects.toMatchObject({ code });
    expect(calls).toBe(1); expect(await snapshot(sql, x)).toEqual(before);
  });
});

it("V06 CAS returning zero refuses receipt and rolls back first version/counter", async () => {
  const x = await fixture(), before = await snapshot(sql, x), name = `cas_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id='${x.sourceId}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON opening_source_versions FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await expect(commit(x)).rejects.toMatchObject({ code: "CONFLICT" }); expect(await snapshot(sql, x)).toEqual(before); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON opening_source_versions`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
});

it.each(["wrapper", "session"] as const)("V07 %s retains conflicting mapping/stale CAS/replay-after-later-revision branches", async mode => {
  const x = await fixture(), repo = createOpeningMaterialImportBindingsRepository(sql);
  const write = (raw: unknown) => mode === "wrapper" ? repo.accept(x.scope, x.selection, raw) : commit(x, raw);
  const first = await write(x.input), before = await snapshot(sql, x);
  expect(await write(x.input)).toEqual({ ...first, duplicate: true });
  for (const raw of [{ ...x.input, questionId: randomUUID() }, { ...x.input, mappingId: randomUUID() }]) {
    await expect(write(raw)).rejects.toMatchObject({ code: "CONFLICT" }); expect(await snapshot(sql, x)).toEqual(before);
  }
  const secondRaw = { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 };
  expect(await write(secondRaw)).toMatchObject({ duplicate: false, manifestRevision: 2 });
  const later = await snapshot(sql, x);
  await expect(write(x.input)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(repo.readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(sql, x)).toEqual(later);
});

it("V06 low-level same-RC double auth then actual completed append and SQL RAISE40001 rolls back", async () => {
  const x = await fixture(), before = await snapshot(sql, x); let calls = 0;
  await expect(sql.begin("isolation level read committed", async tx => {
    calls++; await lockWorkspaceLearningHistory(tx, x.scope); await lockLearningOwner(tx, x.scope);
    await assertIdentitySessionForWriteInTx(tx, x.credential);
    await createOpeningMaterialImportAcceptInTx(sql)(tx, x.scope, x.selection, x.input);
    expect((await snapshot(tx, x)).versions[0]!.row.material_manifest_revision).toBe(1);
    await assertIdentitySessionForWriteInTx(tx, x.credential);
    await tx.unsafe("DO $$ BEGIN RAISE EXCEPTION 'synthetic completed append' USING ERRCODE='40001'; END $$");
  })).rejects.toMatchObject({ code: "40001" });
  expect(calls).toBe(1); expect(await snapshot(sql, x)).toEqual(before);
});

it("V07 duplicate still runs final auth: real clock materialization hook rejects second cut and rolls back caller writes", async () => {
  const x = await fixture(); await commit(x); const before = await snapshot(sql, x);
  let cuts = 0, updates = 0;
  await expect(sql.begin("isolation level read committed", async tx => {
    // Scheduling-only observer delegates every query to the same REAL PG tx;
    // not a fake tx/Sql cast, readonly flag, or production callback seam.
    const observed = new Proxy(tx, { apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      return (async () => {
        const text = args[0].join("?");
        if (text.includes("WITH cut AS MATERIALIZED") && ++cuts === 2)
          await tx`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${x.credential.sessionId}`;
        if (text.includes("UPDATE opening_source_versions")) updates++;
        return Reflect.apply(target, thisArg, args);
      })();
    } });
    return accept(sql, observed, x);
  })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(cuts).toBe(2); expect(updates).toBe(0); expect(await snapshot(sql, x)).toEqual(before);
});

it.each([false, true])("V08 authenticated append competitors wait on history: identical=%s", async identical => {
  const x = await fixture(), a = await connection(), b = await connection(), held = barrier(), release = barrier();
  const first = a.sql.begin("isolation level read committed", async tx => {
    const r = await accept(a.sql, tx, x); held.release(); await release.ready; return r;
  });
  first.catch(held.release); let second: Promise<unknown> | undefined;
  try {
    await Promise.race([held.ready, first]);
    second = b.sql.begin("isolation level read committed", tx => accept(b.sql, tx, x,
      identical ? x.input : { ...x.input, mappingId: randomUUID() }));
    const outcome = second.then(value => ({ value }), error => ({ error }));
    await blocked(b.pid, a.pid); release.release(); const receipt = await first, result = await outcome;
    if (identical) expect(result).toEqual({ value: { ...receipt, duplicate: true } });
    else expect(result).toMatchObject({ error: { code: "CONFLICT" } });
    const state = await snapshot(sql, x);
    expect(Number(state.history[0]!.row.revision)).toBe(1); expect(state.versions[0]!.row.material_manifest.bindings).toHaveLength(1);
  } finally { release.release(); await Promise.allSettled([first, second]); }
});

it.each(["revoke", "disable", "rotation", "expiry"])("V09 committed %s denies first auth and rolls back first counter", async mode => {
  const x = await fixture();
  if (mode === "disable") await sql`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${x.scope.ownerUserId}`;
  else if (mode === "revoke") await sql`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${x.credential.sessionId}`;
  else if (mode === "rotation") await sql`UPDATE sessions SET token_hash=${hashSessionToken(randomUUID())} WHERE id=${x.credential.sessionId}`;
  else await sql`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${x.credential.sessionId}`;
  const before = await snapshot(sql, x);
  await expect(commit(x)).rejects.toMatchObject({ code: "UNAUTHORIZED" }); expect(await snapshot(sql, x)).toEqual(before);
});

it.each(["revoke", "disable", "touch", "rotation"])("V09 %s writer holds row first: native 55P03, whole rollback", async mode => {
  const x = await fixture(), b = await connection(), held = barrier(), release = barrier();
  const holding = b.sql.begin(async tx => {
    if (mode === "disable") await tx`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${x.scope.ownerUserId}`;
    else if (mode === "revoke") await tx`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${x.credential.sessionId}`;
    else if (mode === "touch") await tx`UPDATE sessions SET last_seen_at=clock_timestamp() WHERE id=${x.credential.sessionId}`;
    else await tx`UPDATE sessions SET token_hash=${hashSessionToken(randomUUID())} WHERE id=${x.credential.sessionId}`;
    held.release(); await release.ready;
  });
  holding.catch(held.release);
  try {
    await Promise.race([held.ready, holding]); const before = await snapshot(sql, x);
    await expect(commit(x)).rejects.toMatchObject({ code: "55P03" }); expect(await snapshot(sql, x)).toEqual(before);
  } finally { release.release(); await holding; }
});

it("V09 workspace writer first waits at original owner fence (not universal NOWAIT)", async () => {
  const x = await fixture(), a = await connection(), b = await connection(), held = barrier(), release = barrier();
  const holding = b.sql.begin(async tx => {
    await tx`UPDATE workspaces SET updated_at=clock_timestamp() WHERE id=${x.scope.workspaceId}`;
    held.release(); await release.ready;
  });
  holding.catch(held.release); let appending: Promise<unknown> | undefined;
  try {
    await Promise.race([held.ready, holding]);
    appending = a.sql.begin("isolation level read committed", tx => accept(a.sql, tx, x));
    await blocked(a.pid, b.pid); release.release(); await holding;
    expect(await appending).toMatchObject({ manifestRevision: 1 });
  } finally { release.release(); await Promise.allSettled([holding, appending]); }
});

it.each(["session", "user", "source", "purpose", "workspace"])("V09/V10 %s writer waits until authenticated append outer commit", async mode => {
  const x = await fixture(), a = await connection(), b = await connection(), held = barrier(), release = barrier();
  const first = a.sql.begin("isolation level read committed", async tx => { await accept(a.sql, tx, x); held.release(); await release.ready; });
  first.catch(held.release); let writing: Promise<unknown> | undefined;
  try {
    await Promise.race([held.ready, first]);
    writing = b.sql.begin(async tx => {
      if (mode === "session") await tx`UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=${x.credential.sessionId}`;
      else if (mode === "user") await tx`UPDATE users SET disabled_at=clock_timestamp() WHERE id=${x.scope.ownerUserId}`;
      else if (mode === "source") await tx`UPDATE opening_sources SET parse_state='failed' WHERE id=${x.sourceId}`;
      else if (mode === "purpose") await tx`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE id=${x.membership.id}`;
      else await tx`UPDATE workspaces SET updated_at=clock_timestamp() WHERE id=${x.scope.workspaceId}`;
    });
    await blocked(b.pid, a.pid); release.release(); await first; await writing;
    if (mode !== "workspace") await expect(commit(x)).rejects.toHaveProperty("code");
  } finally { release.release(); await Promise.allSettled([first, writing]); }
});

it.each(["purpose", "us", "retained", "null-reviewer", "foreign-reviewer"])("V10/V11 existing %s guard denies read/replay/new append without mutation", async mode => {
  const x = await fixture(); await commit(x);
  if (mode === "purpose") await sql`UPDATE course_asset_memberships SET purpose='mock_exam' WHERE id=${x.membership.id}`;
  if (mode === "us") await sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond' WHERE id=${x.membership.id}`;
  if (mode === "retained") await sql`UPDATE opening_source_versions SET material_manifest=jsonb_set(material_manifest,'{restoredFromBackup}','true') WHERE source_id=${x.sourceId}`;
  if (mode === "null-reviewer") await sql`UPDATE opening_source_versions SET material_reviewed_by=NULL WHERE source_id=${x.sourceId}`;
  if (mode === "foreign-reviewer") {
    const other = await fixture();
    await sql`UPDATE opening_source_versions SET material_reviewed_by=${other.scope.ownerUserId},
      material_manifest=jsonb_set(material_manifest,'{bindings,0,reviewedBy}',to_jsonb(${other.scope.ownerUserId}::text)) WHERE source_id=${x.sourceId}`;
  }
  const before = await snapshot(sql, x);
  await expect(createOpeningMaterialImportBindingsRepository(sql).readCurrent(x.scope, x.selector)).rejects.toHaveProperty("code");
  for (const raw of [x.input, { ...x.input, mappingId: randomUUID(), expectedManifestRevision: 1 }]) await expect(commit(x, raw)).rejects.toHaveProperty("code");
  expect(await snapshot(sql, x)).toEqual(before);
});

it("V12 low-level actual tx append/read uses returned revision, then final auth; caller error rolls both back", async () => {
  const x = await fixture(), before = await snapshot(sql, x), failure = new Error("caller abort");
  await expect(sql.begin("isolation level read committed", async tx => {
    await lockWorkspaceLearningHistory(tx, x.scope); await lockLearningOwner(tx, x.scope);
    await assertIdentitySessionForWriteInTx(tx, x.credential);
    const receipt = await createOpeningMaterialImportAcceptInTx(sql)(tx, x.scope, x.selection, x.input);
    const repo = createOpeningMaterialImportBindingsRepository(sql);
    await expect(repo.readCurrent(x.scope, { ...x.selector, expectedManifestRevision: x.input.expectedManifestRevision }, tx)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.readCurrent(x.scope, { ...x.selector, expectedManifestRevision: receipt.manifestRevision }, tx)).toMatchObject({ availability: "available" });
    await assertIdentitySessionForWriteInTx(tx, x.credential); throw failure;
  })).rejects.toBe(failure);
  expect(await snapshot(sql, x)).toEqual(before);
});

it("V13 explicit non-guarantee: final valid cut, then expiry before COMMIT still allows commit", async () => {
  const x = await fixture(); let expiry = 0;
  await sql.begin("isolation level read committed", async tx => {
    expiry = Number((await tx`SELECT extract(epoch FROM clock_timestamp()+interval '0.5 second')::float8 AS exp`)[0]!.exp);
    await accept(sql, tx, x, x.input, { ...x.credential, jwtExpiresAtSeconds: expiry });
    // Deliberately invalid production scheduling; documents NOT commit stability.
    await tx`SELECT pg_sleep(0.8)`;
  });
  expect((await sql`SELECT clock_timestamp()>to_timestamp(${expiry}) AS expired`)[0]!.expired).toBe(true);
  expect((await snapshot(sql, x)).versions[0]!.row.material_manifest_revision).toBe(1);
});

it("V01/V12 legacy reader missing/caller-tx/standalone behavior remains and mismatched persisted digest rejects", async () => {
  const x = await fixture(), repo = createOpeningMaterialImportBindingsRepository(sql);
  expect(await repo.readCurrent(x.scope, x.selector)).toEqual({ availability: "unavailable", reason: "binding_missing" });
  await repo.accept(x.scope, x.selection, x.input);
  const before = await snapshot(sql, x);
  await sql.begin("isolation level read committed", async tx => {
    expect(await repo.readCurrent(x.scope, x.selector, tx)).toMatchObject({ availability: "available" });
  });
  expect(await repo.readCurrent(x.scope, { ...x.selector, mappingId: randomUUID() })).toEqual({ availability: "unavailable", reason: "binding_missing" });
  expect(await snapshot(sql, x)).toEqual(before);
  await sql`UPDATE opening_source_versions SET material_manifest=jsonb_set(material_manifest,
    '{bindings,0,questionContentSha256}',to_jsonb(${'b'.repeat(64)}::text)) WHERE source_id=${x.sourceId}`;
  await expect(repo.readCurrent(x.scope, x.selector)).rejects.toMatchObject({ code: "CONFLICT" });
});

it.each(["sha", "chunk", "page", "range", "retained-metadata", "retained-unavailable", "audit-us", "history"])(
  "V10/V12 wrapper and new seam keep existing %s rejection with unchanged state", async mode => {
    const x = await fixture(), repo = createOpeningMaterialImportBindingsRepository(sql);
    await repo.accept(x.scope, x.selection, x.input);
    if (mode === "sha") await sql`UPDATE opening_sources SET sha256=${"a".repeat(64)} WHERE id=${x.sourceId}`;
    if (mode === "chunk") await sql`DELETE FROM opening_source_chunks WHERE id=${x.input.question.locator.chunkId}`;
    if (mode === "page") await sql`UPDATE opening_source_chunks SET page=5 WHERE id=${x.input.question.locator.chunkId}`;
    if (mode === "range") await sql`UPDATE opening_source_chunks SET text='Q' WHERE id=${x.input.question.locator.chunkId}`;
    if (mode === "retained-metadata") await sql`UPDATE opening_source_versions SET bytes=bytes+1 WHERE source_id=${x.sourceId}`;
    if (mode === "retained-unavailable") await sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${x.sourceId}`;
    if (mode === "audit-us") await sql`UPDATE opening_source_versions SET material_reviewed_at=material_reviewed_at+interval '1 microsecond' WHERE source_id=${x.sourceId}`;
    if (mode === "history") await sql`UPDATE opening_workspace_history_revisions SET revision=0 WHERE workspace_id=${x.scope.workspaceId}`;
    const before = await snapshot(sql, x);
    for (const operation of [() => repo.accept(x.scope, x.selection, x.input), () => commit(x), () => repo.readCurrent(x.scope, x.selector)]) {
      await expect(operation()).rejects.toMatchObject({ code: "CONFLICT" }); expect(await snapshot(sql, x)).toEqual(before);
    }
  });

it("V06 legacy wrapper native UPDATE error still rolls back actual state", async () => {
  const x = await fixture(), before = await snapshot(sql, x);
  await trigger(x, "RAISE EXCEPTION 'legacy synthetic' USING ERRCODE='P0001';", async () => {
    await expect(createOpeningMaterialImportBindingsRepository(sql).accept(x.scope, x.selection, x.input)).rejects.toMatchObject({ code: "P0001" });
    expect(await snapshot(sql, x)).toEqual(before);
  });
});

it.each(["standalone", "citation", "empty", "multi-source"])("V14 strict %s pin remains rejected", async mode => {
  const x = await fixture(), before = await snapshot(sql, x), original = x.selection.purposePin;
  const pin = mode === "standalone" ? { ...original, courseId: null }
    : mode === "citation" ? { ...original, materialUse: "citation" as const }
    : mode === "empty" ? { ...original, sources: [] }
    : { ...original, sources: [...original.sources, { ...original.sources[0]!, sourceId: randomUUID() }] };
  await expect(sql.begin("isolation level read committed", tx => createOpeningMaterialImportSessionAcceptInTx(sql)(tx,
    x.credential, { ...x.selection, purposePin: pin }, x.input))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(sql, x)).toEqual(before);
});
