import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hashSessionToken, type OpeningScope } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createSessionJwt } from "../../../apps/web/src/lib/session";
import { GET } from "../../../apps/web/src/app/api/opening/courses/[id]/material-author-review/route";
import { loadMaterialAuthorReviewHost, type MaterialAuthorReviewManifestReader } from "../../../apps/web/src/features/opening/materials/server/material-author-review-host";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>, cookieB: string;
const secret = "material-review-synthetic-test-secret-only";
beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", secret);
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: secret,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  const issued = await runtime.sessions.issue({ userId: f.otherScope.ownerUserId, workspaceId: f.otherScope.workspaceId });
  cookieB = `aistudy_session=${issued.token}`;
});
afterAll(async () => { setAuthRuntimeForTests(null); vi.unstubAllEnvs(); await runtime?.close(); await f?.close(); });

async function seed(scope: OpeningScope = f.scope) {
  const courseId = randomUUID(), sourceId = await backupRows(f.sql, scope).source();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Synthetic review',${courseId})`;
  const membershipId = randomUUID();
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,purpose,role,visibility)
    VALUES(${membershipId},${scope.workspaceId},${courseId},'source',${sourceId},'teaching','core','private')`;
  return { courseId, sourceId, version: 1, membershipId };
}
type Selection = Awaited<ReturnType<typeof seed>>;
async function call(x: Selection, cookie: string | null = f.cookie, extra = "") {
  const request = new Request(`http://review.test/api/opening/courses/${x.courseId}/material-author-review?sourceId=${x.sourceId}&version=${x.version}${extra}`,
    { headers: cookie ? { cookie } : {} });
  const response = await GET(request, { params: Promise.resolve({ id: x.courseId }) });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  return { status: response.status, body: await response.json() as unknown };
}
const unavailable = { status: "unavailable", reason: "manifest_reader_disabled", authorReview: null, contents: [], publishable: false };
const opaque404 = { error: { code: "NOT_FOUND", message: "Material review not found" } };
async function snapshot() {
  const names = await f.sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const state: Record<string, unknown> = {};
  for (const row of names) state[String(row.table_name)] = await f.sql`SELECT to_jsonb(t) AS row
    FROM ${f.sql(String(row.table_name))} t WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId}) ORDER BY to_jsonb(t)::text`;
  return JSON.stringify(state);
}

it("real Request/cookie/JWT/sessionDB A and B get empty unavailable; absent mapping never becomes ready or writes", async () => {
  const a = await seed(), b = await seed(f.otherScope), before = await snapshot();
  expect(await call(a)).toEqual({ status: 200, body: unavailable });
  expect(await call(b, cookieB)).toEqual({ status: 200, body: unavailable });
  expect(await snapshot()).toBe(before);
});

it("foreign course/source/membership and unknown resources share the same opaque 404", async () => {
  const a = await seed(), b = await seed(f.otherScope), a2 = await seed();
  for (const [selection, cookie] of [[b, f.cookie], [a, cookieB], [{ ...a, sourceId: b.sourceId }, f.cookie],
    [{ ...a, sourceId: a2.sourceId }, f.cookie], [{ ...a, courseId: randomUUID() }, f.cookie],
    [{ ...a, sourceId: randomUUID() }, f.cookie]] as const) {
    expect(await call(selection, cookie)).toEqual({ status: 404, body: opaque404 });
  }
  await f.sql`DELETE FROM course_asset_memberships WHERE id=${a.membershipId}`;
  expect(await call(a)).toEqual({ status: 404, body: opaque404 });
});

it("rejects unsigned/tampered/expired JWTs, expired DB session, revoked session, disabled account and token hash mismatch", async () => {
  const x = await seed();
  for (const cookie of [null, "aistudy_session=forged", `${f.cookie}broken`]) expect((await call(x, cookie)).status).toBe(401);
  const issue = () => runtime.sessions.issue({ userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId });
  const expiredId = randomUUID();
  const expiredToken = await createSessionJwt({ sub: f.scope.ownerUserId, workspaceId: f.scope.workspaceId, sid: expiredId }, secret, -60);
  await f.sql`INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(${expiredId},${f.scope.ownerUserId},${hashSessionToken(expiredToken)},now()+interval '1 hour')`;
  expect((await call(x, `aistudy_session=${expiredToken}`)).status).toBe(401);
  const expiredDb = await issue();
  await f.sql`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=${expiredDb.principal.sessionId}`;
  expect((await call(x, `aistudy_session=${expiredDb.token}`)).status).toBe(401);
  const revoked = await issue(), cookie = `aistudy_session=${revoked.token}`;
  expect((await call(x, cookie)).status).toBe(200);
  await runtime.sessions.revoke(revoked.principal.sessionId);
  expect((await call(x, cookie)).status).toBe(401);
  const mismatch = await issue();
  await f.sql`UPDATE sessions SET token_hash=${"0".repeat(64)} WHERE id=${mismatch.principal.sessionId}`;
  expect((await call(x, `aistudy_session=${mismatch.token}`)).status).toBe(401);
  await f.sql`UPDATE users SET disabled_at=now() WHERE id=${f.scope.ownerUserId}`;
  expect((await call(x)).status).toBe(401);
  await f.sql`UPDATE users SET disabled_at=NULL WHERE id=${f.scope.ownerUserId}`;
});

it("rechecks purpose/version/privacy/upload/parse/archive on the next request; help and owner query cannot grant access", async () => {
  const x = await seed();
  expect((await call(x)).status).toBe(200);
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=now() WHERE id=${x.membershipId}`;
  expect((await call(x)).status).toBe(409);
  expect((await call(x, f.cookie, "&explicitHelp=true")).status).toBe(400);
  expect((await call(x, f.cookie, `&ownerUserId=${f.otherScope.ownerUserId}`)).status).toBe(400);
  await f.sql`UPDATE course_asset_memberships SET purpose='teaching',updated_at=now() WHERE id=${x.membershipId}`;
  await backupRows(f.sql, f.scope).exclude(x.sourceId);
  expect((await call(x)).status).toBe(409);
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${x.sourceId}`;
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
  expect((await call(x)).status).toBe(409);
  expect(await call({ ...x, version: 2 })).toEqual({ status: 200, body: unavailable });
  await f.sql`UPDATE opening_sources SET version=1,parse_state='failed' WHERE id=${x.sourceId}`;
  expect((await call(x)).status).toBe(409);
  await f.sql`UPDATE opening_sources SET parse_state='ready',upload_state='pending' WHERE id=${x.sourceId}`;
  expect((await call(x)).status).toBe(409);
  await f.sql`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${x.sourceId}`;
  await f.sql`UPDATE courses SET archived_at=now() WHERE id=${x.courseId}`;
  expect((await call(x)).status).toBe(409);
});

it("ignores unapproved persisted manifest JSON; passes current SHA/bytes/revision to future reader but never its raw result", async () => {
  const x = await seed();
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability,material_manifest)
    SELECT id,version,workspace_id,bytes,sha256,'available',
      ${f.sql.json({ status: "ready", answer: "RAW_ANSWER_CANARY", owner: f.otherScope.ownerUserId })}
    FROM opening_sources WHERE id=${x.sourceId}`;
  expect(await call(x)).toEqual({ status: 200, body: unavailable });
  const [source] = await f.sql`SELECT sha256,bytes FROM opening_sources WHERE id=${x.sourceId}`;
  const observed: unknown[] = [];
  const reader: MaterialAuthorReviewManifestReader = { async readUnavailableReason(input) { observed.push(input); return "no_import"; } };
  const result = await loadMaterialAuthorReviewHost(f.sql, f.scope, x, reader);
  expect(result).toEqual({ ...unavailable, reason: "no_import" });
  expect(observed).toEqual([expect.objectContaining({ ...x, membershipId: x.membershipId,
    sha256: source!.sha256, bytes: Number(source!.bytes), purpose: "teaching", purposeRevision: expect.any(String) })]);
  await f.sql`UPDATE opening_sources SET sha256=${"f".repeat(64)},bytes=bytes+1 WHERE id=${x.sourceId}`;
  await loadMaterialAuthorReviewHost(f.sql, f.scope, x, reader);
  expect(observed[1]).toEqual(expect.objectContaining({ sha256: "f".repeat(64), bytes: Number(source!.bytes) + 1 }));
  const invalid: MaterialAuthorReviewManifestReader = { async readUnavailableReason() { return { status: "ready", answer: "RAW_ANSWER_CANARY" } as never; } };
  await expect(loadMaterialAuthorReviewHost(f.sql, f.scope, x, invalid)).rejects.toThrow("Invalid material manifest reader result");
  await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE id=${x.membershipId}`;
  const before = observed.length;
  await expect(loadMaterialAuthorReviewHost(f.sql, f.scope, x, reader)).rejects.toMatchObject({ status: 409 });
  expect(observed).toHaveLength(before);
});
