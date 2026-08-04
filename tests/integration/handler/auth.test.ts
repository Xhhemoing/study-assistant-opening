import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createSqlClient,
  hashSessionToken,
} from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as login } from "../../../apps/web/src/app/api/auth/login/route";
import { POST as logout } from "../../../apps/web/src/app/api/auth/logout/route";
import { GET as me } from "../../../apps/web/src/app/api/auth/me/route";
import { POST as createDocument } from "../../../apps/web/src/app/api/documents/route";
import {
  GET as getDocument,
  PATCH as patchDocument,
} from "../../../apps/web/src/app/api/documents/[id]/route";
import { GET as listRevisions } from "../../../apps/web/src/app/api/documents/[id]/revisions/route";
import {
  GET as listKnowledgeLinks,
  POST as indexKnowledgeLinks,
} from "../../../apps/web/src/app/api/documents/[id]/links/route";
import {
  GET as getDocumentTags,
  PUT as setDocumentTags,
} from "../../../apps/web/src/app/api/documents/[id]/tags/route";
import {
  GET as listDocumentRelations,
  POST as createDocumentRelation,
} from "../../../apps/web/src/app/api/documents/[id]/relations/route";
import {
  DELETE as deleteDocumentRelation,
  PATCH as updateDocumentRelation,
} from "../../../apps/web/src/app/api/documents/[id]/relations/[relationId]/route";
import { GET as getDocumentProperties } from "../../../apps/web/src/app/api/documents/[id]/properties/route";
import { POST as createCourse } from "../../../apps/web/src/app/api/courses/route";
import { POST as addMembership } from "../../../apps/web/src/app/api/courses/[id]/memberships/route";
import { GET as listCourseAssets } from "../../../apps/web/src/app/api/courses/[id]/assets/route";
import { GET as search } from "../../../apps/web/src/app/api/search/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for workspace authorization tests");
}

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
      sessionCookieSecure: false,
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

  it("requires authentication and validates search query parameters", async () => {
    const unauthenticated = await search(new Request("http://localhost/api/search?q=note"));
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json()).error.code).toBe("UNAUTHENTICATED");

    const user = await registerAs("search-validation");
    const invalid = await search(new Request("http://localhost/api/search?q=&limit=0", {
      headers: withCookie(user.cookie),
    }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION");
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

  it("returns 409 for a stale document patch without adding a revision", async () => {
    const owner = await registerAs("concurrency-owner");
    const blockId = randomUUID();
    const createRes = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Concurrency note",
          blocks: [{ id: blockId, type: "paragraph", content: { text: "v1" } }],
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { document: { id: string } };

    const patch = (title: string) => patchDocument(
      new Request(`http://localhost/api/documents/${created.document.id}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title,
          expectedRevisionNumber: 1,
          blocks: [{ id: blockId, type: "paragraph", content: { text: title } }],
        }),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );

    const first = await patch("v2");
    expect(first.status).toBe(200);
    const stale = await patch("stale");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const current = await getDocument(
      new Request(`http://localhost/api/documents/${created.document.id}`, {
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      document: { title: "v2", currentRevisionNumber: 2 },
    });
    const history = await listRevisions(
      new Request(`http://localhost/api/documents/${created.document.id}/revisions`, {
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: created.document.id }) },
    );
    expect(history.status).toBe(200);
    expect((await history.json()).revisions).toHaveLength(2);
  });

  it("indexes workspace-local wiki links idempotently and enriches soft-deleted targets as broken", async () => {
    const owner = await registerAs("links-owner");
    const source = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Source note",
          blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "[[Target note]]" } }],
        }),
      }),
    );
    const target = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Target note",
          blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "target" } }],
        }),
      }),
    );
    const sourceId = (await source.json()).document.id as string;
    const targetId = (await target.json()).document.id as string;

    const unauthenticated = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${targetId}/links`),
      { params: Promise.resolve({ id: targetId }) },
    );
    expect(unauthenticated.status).toBe(401);

    const indexed = await indexKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          workspaceId: "attacker-supplied-workspace-is-ignored",
          targetTitles: [" Target note ", "Target note", "Does not exist"],
        }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(indexed.status).toBe(200);
    expect(await indexed.json()).toEqual({ indexed: 1 });

    const repeatedIndex = await indexKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ targetTitles: ["Target note"] }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(repeatedIndex.status).toBe(200);
    expect(await repeatedIndex.json()).toEqual({ indexed: 0 });

    const relationsBeforeDelete = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, {
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(relationsBeforeDelete.status).toBe(200);
    const beforeBody = await relationsBeforeDelete.json();
    expect(beforeBody.links).toHaveLength(1);
    expect(beforeBody.links[0]).toMatchObject({
      relationType: "references",
      isIncoming: false,
      from: { id: sourceId, documentId: sourceId, title: "Source note", status: "available" },
      to: { id: targetId, documentId: targetId, title: "Target note", status: "available" },
    });

    const targetBlockId = randomUUID();
    const blockTarget = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Block target",
          blocks: [{ id: targetBlockId, type: "paragraph", content: { text: "target block" } }],
        }),
      }),
    );
    const blockTargetId = (await blockTarget.json()).document.id as string;
    await runtime.library.createRelation({
      workspaceId: owner.user.workspaceId,
      fromType: "document",
      fromId: sourceId,
      toType: "block",
      toId: targetBlockId,
      relationType: "references",
    });
    const targetBlockLinks = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${blockTargetId}/links`, {
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: blockTargetId }) },
    );
    expect(targetBlockLinks.status).toBe(200);
    expect((await targetBlockLinks.json()).links).toContainEqual(expect.objectContaining({
      isIncoming: true,
      from: expect.objectContaining({ id: sourceId, documentId: sourceId }),
      to: expect.objectContaining({ id: targetBlockId, documentId: blockTargetId, type: "block" }),
    }));

    await runtime.library.softDeleteDocument({
      workspaceId: owner.user.workspaceId,
      documentId: targetId,
    });
    const relationsAfterDelete = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, {
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(relationsAfterDelete.status).toBe(200);
    expect((await relationsAfterDelete.json()).links[0]).toMatchObject({
      to: { id: targetId, documentId: targetId, title: null, text: null, status: "broken" },
    });

    const clearedIndex = await indexKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ targetTitles: [] }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(clearedIndex.status).toBe(200);
    expect(await clearedIndex.json()).toEqual({ indexed: 0 });
    const clearedLinks = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${sourceId}/links`, { headers: withCookie(owner.cookie) }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect((await clearedLinks.json()).links).toHaveLength(1);
  });

  it("rejects cross-workspace link reads and indexing", async () => {
    const owner = await registerAs("links-owner-a");
    const attacker = await registerAs("links-owner-b");
    const created = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Private target",
          blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "private" } }],
        }),
      }),
    );
    const documentId = (await created.json()).document.id as string;

    const read = await listKnowledgeLinks(
      new Request(`http://localhost/api/documents/${documentId}/links`, {
        headers: withCookie(attacker.cookie),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(read.status).toBe(403);
    expect((await read.json()).error.code).toBe("WORKSPACE_FORBIDDEN");

    const index = await indexKnowledgeLinks(
      new Request(`http://localhost/api/documents/${documentId}/links`, {
        method: "POST",
        headers: withCookie(attacker.cookie),
        body: JSON.stringify({ targetTitles: ["Private target"] }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(index.status).toBe(403);
  });

  it("persists normalized tags in the owner workspace and allows an intentional clear", async () => {
    const owner = await registerAs("tags-owner");
    const attacker = await registerAs("tags-attacker");
    const created = await createDocument(
      new Request("http://localhost/api/documents", {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          title: "Tagged note",
          blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "body" } }],
        }),
      }),
    );
    const documentId = (await created.json()).document.id as string;

    const initial = await getDocumentTags(
      new Request(`http://localhost/api/documents/${documentId}/tags`, { headers: withCookie(owner.cookie) }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ tags: [] });

    const saved = await setDocumentTags(
      new Request(`http://localhost/api/documents/${documentId}/tags`, {
        method: "PUT",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          workspaceId: attacker.user.workspaceId,
          tags: ["  \uFF34\uFF2F\uFF30\uFF29\uFF23  ", "topic", "\u6807\u7B7E\u00A0\u00A0\u590D\u4E60"],
        }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ tags: ["TOPIC", "\u6807\u7B7E \u590D\u4E60"] });

    const denied = await getDocumentTags(
      new Request(`http://localhost/api/documents/${documentId}/tags`, { headers: withCookie(attacker.cookie) }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("WORKSPACE_FORBIDDEN");

    const deniedWrite = await setDocumentTags(
      new Request(`http://localhost/api/documents/${documentId}/tags`, {
        method: "PUT",
        headers: withCookie(attacker.cookie),
        body: JSON.stringify({ tags: ["attacker"] }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(deniedWrite.status).toBe(403);
    expect((await deniedWrite.json()).error.code).toBe("WORKSPACE_FORBIDDEN");

    const cleared = await setDocumentTags(
      new Request(`http://localhost/api/documents/${documentId}/tags`, {
        method: "PUT",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ tags: [] }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ tags: [] });
  });

  it("authors outgoing relations and exposes non-tag document properties within the owner workspace", async () => {
    const owner = await registerAs("relation-owner");
    const attacker = await registerAs("relation-attacker");
    const sourceBlockId = randomUUID();
    const targetBlockId = randomUUID();
    const create = async (cookie: string, title: string, blockId: string) => {
      const response = await createDocument(
        new Request("http://localhost/api/documents", {
          method: "POST",
          headers: withCookie(cookie),
          body: JSON.stringify({
            title,
            blocks: [{ id: blockId, type: "paragraph", content: { text: `${title} body` } }],
          }),
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).document.id as string;
    };
    const sourceId = await create(owner.cookie, "Relation source", sourceBlockId);
    const targetId = await create(owner.cookie, "Relation target", targetBlockId);

    const unauthenticated = await listDocumentRelations(
      new Request(`http://localhost/api/documents/${sourceId}/relations`),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(unauthenticated.status).toBe(401);

    const created = await createDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({
          to: { type: "document", id: targetId },
          relationType: "references",
        }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(created.status).toBe(201);
    const relation = (await created.json()).relation as { id: string; relationType: string; from: { id: string }; to: { id: string } };
    const selfRelation = await createDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ to: { type: "document", id: sourceId }, relationType: "references" }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(selfRelation.status).toBe(400);
    expect((await selfRelation.json()).error.code).toBe("VALIDATION");
    expect(relation).toMatchObject({ relationType: "references", from: { id: sourceId }, to: { id: targetId } });

    const updated = await updateDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations/${relation.id}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ relationType: "supports" }),
      }),
      { params: Promise.resolve({ id: sourceId, relationId: relation.id }) },
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).relation).toMatchObject({ id: relation.id, relationType: "supports" });

    const sameEndpoints = await createDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations`, {
        method: "POST",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ to: { type: "document", id: targetId }, relationType: "references" }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(sameEndpoints.status).toBe(201);
    const collision = await updateDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations/${relation.id}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ relationType: "references" }),
      }),
      { params: Promise.resolve({ id: sourceId, relationId: relation.id }) },
    );
    expect(collision.status).toBe(409);
    expect((await collision.json()).error.code).toBe("CONFLICT");

    const incomingMutation = await updateDocumentRelation(
      new Request(`http://localhost/api/documents/${targetId}/relations/${relation.id}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ relationType: "related" }),
      }),
      { params: Promise.resolve({ id: targetId, relationId: relation.id }) },
    );
    expect(incomingMutation.status).toBe(404);

    const incomingInvalidBody = await updateDocumentRelation(
      new Request(`http://localhost/api/documents/${targetId}/relations/${relation.id}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ relationType: "not-a-relation" }),
      }),
      { params: Promise.resolve({ id: targetId, relationId: relation.id }) },
    );
    expect(incomingInvalidBody.status).toBe(404);

    await runtime.library.setProperty({
      workspaceId: owner.user.workspaceId,
      subjectType: "document",
      subjectId: sourceId,
      key: "priority",
      valueType: "number",
      value: 3,
    });
    await runtime.library.setProperty({
      workspaceId: owner.user.workspaceId,
      subjectType: "document",
      subjectId: sourceId,
      key: "tags",
      valueType: "json",
      value: ["hidden-here"],
    });
    await runtime.library.setProperty({
      workspaceId: owner.user.workspaceId,
      subjectType: "block",
      subjectId: sourceBlockId,
      key: "flagged",
      valueType: "boolean",
      value: true,
    });
    await runtime.library.setProperty({
      workspaceId: owner.user.workspaceId,
      subjectType: "block",
      subjectId: targetBlockId,
      key: "foreign",
      valueType: "string",
      value: "not-on-source",
    });

    const properties = await getDocumentProperties(
      new Request(`http://localhost/api/documents/${sourceId}/properties`, { headers: withCookie(owner.cookie) }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(properties.status).toBe(200);
    expect(await properties.json()).toMatchObject({
      document: [{ key: "priority", value: 3 }],
      blocks: [{ blockId: sourceBlockId, properties: [{ key: "flagged", value: true }] }],
    });

    const attackerSourceId = await create(attacker.cookie, "Attacker relation source", randomUUID());
    const attackerTargetId = await create(attacker.cookie, "Attacker relation target", randomUUID());
    const attackerRelation = await createDocumentRelation(
      new Request(`http://localhost/api/documents/${attackerSourceId}/relations`, {
        method: "POST",
        headers: withCookie(attacker.cookie),
        body: JSON.stringify({ to: { type: "document", id: attackerTargetId }, relationType: "references" }),
      }),
      { params: Promise.resolve({ id: attackerSourceId }) },
    );
    const attackerRelationId = (await attackerRelation.json()).relation.id as string;
    const foreignRelationProbe = await updateDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations/${attackerRelationId}`, {
        method: "PATCH",
        headers: withCookie(owner.cookie),
        body: JSON.stringify({ relationType: "related" }),
      }),
      { params: Promise.resolve({ id: sourceId, relationId: attackerRelationId }) },
    );
    expect(foreignRelationProbe.status).toBe(404);

    const deniedRead = await listDocumentRelations(
      new Request(`http://localhost/api/documents/${sourceId}/relations`, { headers: withCookie(attacker.cookie) }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(deniedRead.status).toBe(403);
    const deniedCreate = await createDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations`, {
        method: "POST",
        headers: withCookie(attacker.cookie),
        body: JSON.stringify({ to: { type: "document", id: targetId }, relationType: "related" }),
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(deniedCreate.status).toBe(403);
    const deniedProperties = await getDocumentProperties(
      new Request(`http://localhost/api/documents/${sourceId}/properties`, { headers: withCookie(attacker.cookie) }),
      { params: Promise.resolve({ id: sourceId }) },
    );
    expect(deniedProperties.status).toBe(403);

    const deleted = await deleteDocumentRelation(
      new Request(`http://localhost/api/documents/${sourceId}/relations/${relation.id}`, {
        method: "DELETE",
        headers: withCookie(owner.cookie),
      }),
      { params: Promise.resolve({ id: sourceId, relationId: relation.id }) },
    );
    expect(deleted.status).toBe(204);
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
