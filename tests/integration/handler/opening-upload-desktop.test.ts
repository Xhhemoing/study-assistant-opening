import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { createOpeningTestStorage, pdfBytes, pdfSha } from "../opening-storage-fixture";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as listSources, POST as beginUpload } from "../../../apps/web/src/app/api/opening/sources/route";
import { POST as completeUpload } from "../../../apps/web/src/app/api/opening/sources/[id]/complete/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for opening upload handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
const storage = createOpeningTestStorage();
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
const trackedKeys: string[] = [];

function request(path: string, method = "GET", body?: unknown, authCookie = cookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(authCookie ? { cookie: authCookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerUser(): Promise<string> {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `upload-${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Upload owner",
    }),
  }));
  expect(response.status).toBe(201);
  const session = response.headers.get("set-cookie")?.match(new RegExp(`${cookieName}=([^;]+)`))?.[1];
  if (!session) throw new Error("registration did not return a session cookie");
  return `${cookieName}=${session}`;
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-upload-handler-secret-32chars!!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser();
});

beforeEach(async () => {
  await sql`TRUNCATE opening_sources, opening_jobs, opening_outbox RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  for (const key of [...new Set(trackedKeys)]) {
    await storage.deleteObject(key).catch(() => undefined);
  }
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening desktop upload handlers", () => {
  it("requires a session for listing and beginning an upload", async () => {
    expect((await listSources(request("/api/opening/sources", "GET", undefined, ""))).status).toBe(401);
    expect((await beginUpload(request("/api/opening/sources", "POST", {
      name: "lesson.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha,
    }, ""))).status).toBe(401);
  });

  it("keeps upload state recoverable across a refresh and completes idempotently", async () => {
    const ticketResponse = await beginUpload(request("/api/opening/sources", "POST", {
      name: "lesson.pdf", mime: "application/pdf", bytes: pdfBytes.length, sha256: pdfSha,
    }));
    expect(ticketResponse.status).toBe(201);
    const ticket = await ticketResponse.json() as { source: { id: string; uploadState: string }; uploadUrl: string };
    trackedKeys.push(storage.stagingKey(ticket.source.id), storage.finalKey(ticket.source.id, 0));
    expect(ticket.source.uploadState).toBe("pending");

    const pendingList = await listSources(request("/api/opening/sources"));
    expect(pendingList.status).toBe(200);
    expect((await pendingList.json() as Array<{ id: string; uploadState: string }>).find((row) => row.id === ticket.source.id)?.uploadState).toBe("pending");

    const beforePut = await completeUpload(request(`/api/opening/sources/${ticket.source.id}/complete`, "POST"), { params: Promise.resolve({ id: ticket.source.id }) });
    expect(beforePut.status).toBe(400);

    const put = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBytes,
    });
    expect(put.status).toBe(200);

    const completed = await completeUpload(request(`/api/opening/sources/${ticket.source.id}/complete`, "POST"), { params: Promise.resolve({ id: ticket.source.id }) });
    expect(completed.status).toBe(200);
    expect((await completed.json() as { uploadState: string; parseState: string })).toMatchObject({ uploadState: "uploaded", parseState: "not_started" });

    const refreshedList = await listSources(request("/api/opening/sources"));
    expect(refreshedList.status).toBe(200);
    expect((await refreshedList.json() as Array<{ id: string; uploadState: string }>).find((row) => row.id === ticket.source.id)?.uploadState).toBe("uploaded");

    const replay = await completeUpload(request(`/api/opening/sources/${ticket.source.id}/complete`, "POST"), { params: Promise.resolve({ id: ticket.source.id }) });
    expect(replay.status).toBe(200);
    const jobs = await sql`SELECT count(*)::int AS count FROM opening_jobs WHERE kind = 'parse' AND payload->>'sourceId' = ${ticket.source.id}`;
    expect(jobs[0]?.count).toBe(1);
  });
});
