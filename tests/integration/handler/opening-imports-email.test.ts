import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createOpeningEmailImportTestSourceService } from "../../../apps/web/src/features/opening/sources/email-import-test-service";

(globalThis as { __openingEmailImportSourceServiceFactory?: unknown }).__openingEmailImportSourceServiceFactory =
  createOpeningEmailImportTestSourceService;
const emailRoute = await import("../../../apps/web/src/app/api/opening/imports/email/route");
const postImportEmail = emailRoute.POST;

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  await f.sql`DELETE FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
  setAuthRuntimeForTests(runtime);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  vi.unstubAllGlobals();
  await runtime?.close();
  await f?.close();
});

function importEmail(body: FormData | string, authenticated = true, contentType?: string) {
  return postImportEmail(new Request("https://localhost/api/opening/imports/email", {
    method: "POST",
    headers: {
      ...(authenticated ? { cookie: f.cookie } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  }));
}

function emailForm(name = "lesson.eml", mime = "message/rfc822", content = "From: a@example.edu\r\nSubject: lesson\r\n\r\nhello") {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mime }), name);
  return form;
}

describe("manual .eml import HTTP boundary", () => {
  it("requires a session", async () => {
    expect((await importEmail(emailForm(), false)).status).toBe(401);
  });

  it("requires multipart form data", async () => {
    expect((await importEmail("not-form-data", true, "text/plain")).status).toBe(400);
    expect((await importEmail(new FormData())).status).toBe(400);
  });

  it("accepts only bounded .eml messages", async () => {
    expect((await importEmail(emailForm("lesson.txt", "text/plain", "not mail"))).status).toBe(400);
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "message/rfc822" }), "");
    expect((await importEmail(form)).status).toBe(400);
  });

  it("rejects an oversized email before creating a source", async () => {
    const oversized = emailForm("lesson.eml", "message/rfc822", "x".repeat(25 * 1024 * 1024 + 1));
    const response = await importEmail(oversized);
    expect(response.status).toBe(413);
    expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });

  it("stores an uploaded .eml as a manual source", async () => {
    const response = await importEmail(emailForm());
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({
      sourceId: "11111111-1111-4111-8111-111111111111",
      name: "lesson.eml",
      manual: true,
      bytes: expect.any(Number),
    });
  });

  it("does not write opening_import_receipt rows for manual .eml fallback", async () => {
    const before = await f.sql`SELECT count(*)::int AS count FROM opening_import_receipts WHERE workspace_id=${f.scope.workspaceId}`;
    const response = await importEmail(emailForm("notes.eml"));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ manual: true });
    const after = await f.sql`SELECT count(*)::int AS count FROM opening_import_receipts WHERE workspace_id=${f.scope.workspaceId}`;
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count));
  });
});
