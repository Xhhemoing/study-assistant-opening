import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { GET as list, POST as create } from "../../../apps/web/src/app/api/documents/[id]/revision-proposals/route";
import { GET as getProposal } from "../../../apps/web/src/app/api/revision-proposals/[id]/route";
import { POST as createDocument } from "../../../apps/web/src/app/api/documents/route";
import { POST as review } from "../../../apps/web/src/app/api/revision-proposals/[id]/review/route";
import { POST as resolve } from "../../../apps/web/src/app/api/revision-proposals/[id]/resolve/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for revision proposal handler tests");
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, cookie?: string, body?: unknown) => new Request("http://localhost/api", { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("revision proposal handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime>;
  beforeAll(async () => { await applyMigrations(sql); runtime = createAuthRuntime({ databaseUrl, authSecret: "revision-handler-secret-at-least-32-chars", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" }); setAuthRuntimeForTests(runtime); });
  beforeEach(async () => { await sql`TRUNCATE revision_proposals, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`; });
  afterAll(async () => { setAuthRuntimeForTests(null); await runtime.close(); await sql.end({ timeout: 5 }); });

  it("requires authentication before listing or creating", async () => {
    const response = await list(request("GET"), context(randomUUID()));
    expect(response.status).toBe(401);
  });

  it("keeps review actions principal-bound and returns malformed payload errors", async () => {
    const response = await create(request("POST", undefined, { proposedBlocks: [] }), context(randomUUID()));
    expect(response.status).toBe(401);
    const reviewResponse = await review(request("POST", undefined, { action: "accept" }), context(randomUUID()));
    expect(reviewResponse.status).toBe(401);
    const resolveResponse = await resolve(request("POST", undefined, { action: "preserve_both" }), context(randomUUID()));
    expect(resolveResponse.status).toBe(401);
  });

  it("validates malformed payloads after authentication", async () => {
    const registered = await register(request("POST", undefined, {
      email: `revision-handler-${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Revision handler",
    }));
    expect(registered.status).toBe(201);
    const cookie = registered.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![0];

    const response = await create(request("POST", cookie, { proposedBlocks: [] }), context(randomUUID()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("denies listing a document from another authenticated workspace", async () => {
    const registerUser = async (label: string) => {
      const response = await register(request("POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }));
      expect(response.status).toBe(201);
      return response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![0]!;
    };
    const ownerCookie = await registerUser("revision-owner");
    const otherCookie = await registerUser("revision-other");
    const documentResponse = await createDocument(request("POST", ownerCookie, {
      title: "Owner note",
      lifecycle: "confirmed",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "owner" } }],
    }));
    expect(documentResponse.status).toBe(201);
    const documentId = (await documentResponse.json()).document.id as string;

    const response = await list(request("GET", otherCookie), context(documentId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "WORKSPACE_FORBIDDEN" } });
  });

  it("redacts hidden answer blocks, rejects forgery with 400, and preserves hidden blocks on accept/resolve", async () => {
    const registered = await register(request("POST", undefined, {
      email: `revision-protected-${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Revision protected",
    }));
    expect(registered.status).toBe(201);
    const cookie = registered.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![0]!;
    const workspaceId = (await registered.json()).user.workspaceId as string;

    const leadAnswerId = randomUUID();
    const visibleId = randomUUID();
    const midSolutionId = randomUUID();
    const provenanceAnswerId = randomUUID();
    const trailAnswerId = randomUUID();
    const secrets = [
      "HTTP_LEAD_ANSWER_SECRET",
      "HTTP_MID_SOLUTION_SECRET",
      "HTTP_PROVENANCE_ANSWER_SECRET",
      "HTTP_TRAIL_ANSWER_SECRET",
    ];

    const createdDoc = await runtime.library.createDocument({
      workspaceId,
      title: "Protected Note",
      lifecycle: "confirmed",
      blocks: [
        { id: leadAnswerId, type: "answer_key", content: { answer: secrets[0] } },
        { id: visibleId, type: "paragraph", content: { text: "HTTP_PUBLIC_BODY" } },
        { id: midSolutionId, type: "text", content: { blockType: "solution", text: secrets[1] } },
        { id: provenanceAnswerId, type: "paragraph", content: { text: secrets[2] } },
        { id: trailAnswerId, type: "solution", content: { solution: secrets[3] } },
      ],
    });
    await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${createdDoc.id},${workspaceId},${sql.json([{ answerKeyBlockIds: [provenanceAnswerId.toUpperCase()] }])})`;

    const basePayload = {
      source: { kind: "user", provider: null, model: null, sourceId: null, metadata: {} },
      provenance: { origin: "manual", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: 1 },
      supportState: "supported",
    };

    // 1. Forged answer blocks and protected ID reuse are rejected with HTTP 400.
    const invalidBodies = [
      { ...basePayload, proposedBlocks: [{ id: randomUUID(), type: "answer_key", position: 0, content: { answer: "forged" } }] },
      { ...basePayload, proposedBlocks: [{ id: randomUUID(), type: "paragraph", role: "answer_key", position: 0, content: { text: "forged role" } }] },
      { ...basePayload, proposedBlocks: [{ id: randomUUID(), type: "text", position: 0, content: { blockType: "solution", text: "forged content" } }] },
      { ...basePayload, proposedBlocks: [{ id: leadAnswerId, type: "paragraph", position: 0, content: { text: "reuse lead" } }] },
      { ...basePayload, proposedBlocks: [{ id: provenanceAnswerId.toUpperCase(), type: "paragraph", position: 0, content: { text: "reuse provenance" } }] },
    ];
    for (const body of invalidBodies) {
      const res = await create(request("POST", cookie, body), context(createdDoc.id));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
    }

    // 2. Creating, listing, and reading a valid proposal never leaks hidden answer blocks.
    const createdRes = await create(request("POST", cookie, {
      ...basePayload,
      proposedTitle: "Protected Note v2",
      proposedBlocks: [{ id: visibleId, type: "paragraph", position: 0, content: { text: "HTTP_PUBLIC_UPDATED" } }],
    }), context(createdDoc.id));
    expect(createdRes.status).toBe(201);
    const createdBody = await createdRes.json();
    const proposalId = createdBody.proposal.id as string;

    const listRes = await list(request("GET", cookie), context(createdDoc.id));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    const getRes = await getProposal(request("GET", cookie), context(proposalId));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();

    for (const payload of [createdBody, listBody, getBody]) {
      for (const secret of secrets) {
        expect(JSON.stringify(payload)).not.toContain(secret);
      }
    }
    expect(createdBody.proposal.baseBlocks.map((b: { id: string }) => b.id)).toEqual([visibleId]);

    // 3. Accepting a visible-only proposal returns redacted blocks while preserving hidden blocks in DB.
    const acceptRes = await review(request("POST", cookie, { action: "accept" }), context(proposalId));
    expect(acceptRes.status).toBe(200);
    const acceptBody = await acceptRes.json();
    expect(acceptBody.proposal.status).toBe("accepted");
    expect(acceptBody.document.blocks.map((b: { id: string }) => b.id)).toEqual([visibleId]);
    for (const secret of secrets) {
      expect(JSON.stringify(acceptBody)).not.toContain(secret);
    }

    const trustedAfterAccept = await runtime.library.getDocument({
      workspaceId,
      documentId: createdDoc.id,
      includeAnswerKeys: true,
    });
    expect(trustedAfterAccept.blocks.map((b) => b.id)).toEqual([
      leadAnswerId,
      visibleId,
      midSolutionId,
      provenanceAnswerId,
      trailAnswerId,
    ]);
    const [rev2] = await sql`SELECT blocks FROM library_revisions WHERE document_id=${createdDoc.id} AND revision_number=2`;
    expect((rev2!.blocks as Array<{ id: string }>).map((b) => b.id)).toEqual([
      leadAnswerId,
      visibleId,
      midSolutionId,
      provenanceAnswerId,
      trailAnswerId,
    ]);

    // 4. Accepting a pending proposal whose proposed block ID later became protected fails with HTTP 400.
    const lateProtectedId = randomUUID();
    const secondCreated = await create(request("POST", cookie, {
      ...basePayload,
      proposedBlocks: [
        { id: visibleId, type: "paragraph", position: 0, content: { text: "HTTP_PUBLIC_UPDATED" } },
        { id: lateProtectedId, type: "paragraph", position: 1, content: { text: "will become protected" } },
      ],
    }), context(createdDoc.id));
    expect(secondCreated.status).toBe(201);
    const secondProposalId = (await secondCreated.json()).proposal.id as string;
    await sql`UPDATE opening_note_provenance
      SET context_source_refs = context_source_refs || ${sql.json([{ answerKeyBlockIds: [lateProtectedId] }])}::jsonb
      WHERE document_id=${createdDoc.id}`;
    const blockedAccept = await review(request("POST", cookie, { action: "accept" }), context(secondProposalId));
    expect(blockedAccept.status).toBe(400);
    await expect(blockedAccept.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
  });
});
