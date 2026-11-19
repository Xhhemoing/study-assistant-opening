import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET, POST } from "../../../apps/web/src/app/api/opening/plans/day-adjustment/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime>;
let cookie: string;

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "day-adjustment-handler-secret-32chars",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  const response = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${randomUUID()}@example.com`,
        password: "password123",
        displayName: "day-adjust-handler",
      }),
    }),
  );
  expect(response.status).toBe(201);
  cookie = `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

function getRequest(query = "", authenticated = true) {
  return new Request(`http://localhost/api/opening/plans/day-adjustment${query}`, {
    method: "GET",
    headers: authenticated ? { cookie } : {},
  });
}

function postRequest(body: unknown, authenticated = true) {
  return new Request("http://localhost/api/opening/plans/day-adjustment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

it("requires authentication and always emits Cache-Control: private, no-store", async () => {
  const unauthGet = await GET(getRequest("", false));
  expect(unauthGet.status).toBe(401);
  expect(unauthGet.headers.get("cache-control")).toBe("private, no-store");

  const unauthPost = await POST(postRequest({ action: "preview" }, false));
  expect(unauthPost.status).toBe(401);
  expect(unauthPost.headers.get("cache-control")).toBe("private, no-store");
});

it("rejects unknown query params and malformed/forged payloads with 400 and private, no-store", async () => {
  const badQuery = await GET(getRequest("?forged=1"));
  expect(badQuery.status).toBe(400);
  expect(badQuery.headers.get("cache-control")).toBe("private, no-store");

  const badBody = await POST(
    postRequest({
      action: "declare_today",
      clientKey: randomUUID(),
      localDate: "2026-02-30",
      expectedTimeZone: "Asia/Shanghai",
      expectedExceptionRevision: 0,
      remainingMinutes: 15,
      forgedField: true,
    }),
  );
  expect(badBody.status).toBe(400);
  expect(badBody.headers.get("cache-control")).toBe("private, no-store");
});

it("handles GET preview -> POST declare_today -> idempotent replay -> 409 selection_mismatch", async () => {
  const initialRes = await GET(getRequest());
  expect(initialRes.status).toBe(200);
  expect(initialRes.headers.get("cache-control")).toBe("private, no-store");
  const initial = (await initialRes.json()) as {
    sourceDate: string;
    timeZone: string;
    exceptionRevision: number;
    status: string;
  };
  expect(initial.status).toBe("no_exception");

  const clientKey = randomUUID();
  const declarePayload = {
    action: "declare_today",
    clientKey,
    localDate: initial.sourceDate,
    expectedTimeZone: initial.timeZone,
    expectedExceptionRevision: initial.exceptionRevision,
    remainingMinutes: 15,
  };
  const declareRes = await POST(postRequest(declarePayload));
  expect(declareRes.status).toBe(200);
  expect(declareRes.headers.get("cache-control")).toBe("private, no-store");
  const declared = (await declareRes.json()) as {
    receipt: { remainingMinutes: number; revision: number; replayed: boolean };
    preview: { exceptionRevision: number };
  };
  expect(declared.receipt).toMatchObject({ remainingMinutes: 15, revision: 1, replayed: false });
  expect(declared.preview.exceptionRevision).toBe(1);

  const replayRes = await POST(postRequest(declarePayload));
  expect(replayRes.status).toBe(200);
  const replayed = (await replayRes.json()) as { receipt: { replayed: boolean } };
  expect(replayed.receipt.replayed).toBe(true);

  const mismatchRes = await POST(
    postRequest({ ...declarePayload, remainingMinutes: 30 }),
  );
  expect(mismatchRes.status).toBe(409);
  expect(mismatchRes.headers.get("cache-control")).toBe("private, no-store");
  const mismatch = (await mismatchRes.json()) as { error: { reason?: string } };
  expect(mismatch.error.reason).toBe("selection_mismatch");
});
