import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createSqlClient,
  hashSessionToken,
} from "@aistudy/database";
import { POST as register } from "../../apps/web/src/app/api/auth/register/route";
import { POST as login } from "../../apps/web/src/app/api/auth/login/route";
import { POST as logout } from "../../apps/web/src/app/api/auth/logout/route";
import { GET as me } from "../../apps/web/src/app/api/auth/me/route";
import { POST as createDocument } from "../../apps/web/src/app/api/documents/route";
import {
  GET as getDocument,
  PATCH as patchDocument,
} from "../../apps/web/src/app/api/documents/[id]/route";
import { GET as listRevisions } from "../../apps/web/src/app/api/documents/[id]/revisions/route";
import { POST as createCourse } from "../../apps/web/src/app/api/courses/route";
import { POST as addMembership } from "../../apps/web/src/app/api/courses/[id]/memberships/route";
import { GET as listCourseAssets } from "../../apps/web/src/app/api/courses/[id]/assets/route";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy";

const AUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
const COOKIE = "aistudy_session";

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing set-cookie");
  const match = setCookie.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!match) throw new Error(`cookie ${COOKIE} not found in ${setCookie}`);
  return `${COOKIE}=${match[1]}`;
}

function withCookie(cookie: string): HeadersInit {
  return { cookie, "content-type": "application/json" };
}

describe("workspace authorization via direct API access", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime>;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: AUTH_SECRET,
      sessionTtlSeconds: 3600,
      authCookieName: COOKIE,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime.close();
    await sql.end({ timeout: 5 });
  });

  async function registerAs(label: string) {
    const email = `${label}-${randomUUID()}@example.com`;
    const res = await register(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "password123",
          displayName: label,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; workspaceId: string; email: string };
    };
    return { cookie: cookieFrom(res), user: body.user, email };
  }

  it("returns 401 without authentication", async () => {
    const res = await me(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("prevents user A from reading or mutating user B resources", async () => {
    const a = await registerAs("alice");
    const b = await registerAs("bob");

    // B creates a document
    const createRes = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(b.cookie),
        body: JSON.stringify({
          title: "Bob private note",
          // attacker-supplied workspace must be ignored
          workspaceId: a.user.workspaceId,
          blocks: [
            {
              id: randomUUID(),
              type: "paragraph",
              content: { text: "secret-from-bob" },
            },
          ],
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      document: { id: string; workspaceId: string };
    };
    expect(created.document.workspaceId).toBe(b.user.workspaceId);

    // A cannot read B's document
    const readRes = await getDocument(
      new Request(`http://localhost/api/documents/${created.document.id}`, {
        headers: withCookie(a.cookie),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(readRes.status).toBe(403);
    expect((await readRes.json()).error.code).toBe("WORKSPACE_FORBIDDEN");

    // A cannot patch B's document
    const patchRes = await patchDocument(
      new Request(`http://localhost/api/documents/${created.document.id}`, {
        method: "PATCH",
        headers: withCookie(a.cookie),
        body: JSON.stringify({
          title: "hijacked",
          blocks: [
            {
              id: randomUUID(),
              type: "paragraph",
              content: { text: "nope" },
            },
          ],
        }),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(patchRes.status).toBe(403);

    // A cannot list B's revisions
    const revRes = await listRevisions(
      new Request(
        `http://localhost/api/documents/${created.document.id}/revisions`,
        { headers: withCookie(a.cookie) },
      ),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(revRes.status).toBe(403);

    // B creates a course
    const courseRes = await createCourse(
      new Request("http://localhost/api/courses", {
        method: "POST",
        headers: withCookie(b.cookie),
        body: JSON.stringify({ title: "Bob Course", slug: "bob-course" }),
      }),
    );
    expect(courseRes.status).toBe(201);
    const course = (await courseRes.json()) as { course: { id: string } };

    await addMembership(
      new Request(
        `http://localhost/api/courses/${course.course.id}/memberships`,
        {
          method: "POST",
          headers: withCookie(b.cookie),
          body: JSON.stringify({
            assetType: "document",
            assetId: created.document.id,
            role: "core",
            visibility: "course",
          }),
        },
      ),
      { params: Promise.resolve({ id: course.course.id }) },
    );

    const assetsRes = await listCourseAssets(
      new Request(
        `http://localhost/api/courses/${course.course.id}/assets`,
        { headers: withCookie(a.cookie) },
      ),
      { params: Promise.resolve({ id: course.course.id }) },
    );
    expect(assetsRes.status).toBe(403);

    // B can still read own document
    const own = await getDocument(
      new Request(`http://localhost/api/documents/${created.document.id}`, {
        headers: withCookie(b.cookie),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(own.status).toBe(200);
    const ownBody = await own.json();
    expect(ownBody.document.title).toBe("Bob private note");
  });

  it("supports login logout and rejects revoked sessions", async () => {
    const email = `carol-${randomUUID()}@example.com`;
    const reg = await register(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "password123",
          displayName: "Carol",
        }),
      }),
    );
    expect(reg.status).toBe(201);
    const cookie = cookieFrom(reg);

    const meOk = await me(
      new Request("http://localhost/api/auth/me", {
        headers: withCookie(cookie),
      }),
    );
    expect(meOk.status).toBe(200);

    const out = await logout(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: withCookie(cookie),
      }),
    );
    expect(out.status).toBe(200);

    const meDenied = await me(
      new Request("http://localhost/api/auth/me", {
        headers: withCookie(cookie),
      }),
    );
    expect(meDenied.status).toBe(401);

    const loginRes = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password123" }),
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginCookie = cookieFrom(loginRes);
    const meAgain = await me(
      new Request("http://localhost/api/auth/me", {
        headers: withCookie(loginCookie),
      }),
    );
    expect(meAgain.status).toBe(200);
  });

  it("rejects invalid credentials without leaking existence details", async () => {
    const res = await login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "nobody@example.com",
          password: "password123",
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("stores only hashed session tokens server-side", async () => {
    const a = await registerAs("dave");
    const identity = createIdentityRepository(sql);
    const user = await identity.findUserByEmail(a.user.email);
    expect(user).not.toBeNull();
    const sessions = await sql`
      SELECT token_hash FROM sessions WHERE user_id = ${user!.id}
    `;
    expect(sessions.length).toBeGreaterThan(0);
    const token = a.cookie.split("=")[1]!;
    expect(sessions[0]!.token_hash).toBe(hashSessionToken(token));
    expect(sessions[0]!.token_hash).not.toBe(token);
  });
});
