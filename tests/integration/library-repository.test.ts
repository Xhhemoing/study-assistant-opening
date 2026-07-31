import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  LibraryError,
  type IdentityRepository,
  type LibraryRepository,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for library repository tests");
}

describe("library repository foundation", () => {
  const sql = createSqlClient(databaseUrl);
  let repo: LibraryRepository;
  let identity: IdentityRepository;
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    repo = createLibraryRepository(sql);
    identity = createIdentityRepository(sql);
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

    const userA = await identity.createUserWithWorkspace({
      email: `lib-a-${randomUUID()}@example.com`,
      displayName: "Lib A",
      passwordHash: "scrypt$not-used",
    });
    const userB = await identity.createUserWithWorkspace({
      email: `lib-b-${randomUUID()}@example.com`,
      displayName: "Lib B",
      passwordHash: "scrypt$not-used",
    });
    workspaceA = userA.workspace.id;
    workspaceB = userB.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("creates a document with ordered blocks and initial revision snapshot", async () => {
    const blockA = randomUUID();
    const blockB = randomUUID();

    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Linear algebra notes",
      lifecycle: "scratch",
      blocks: [
        {
          id: blockA,
          type: "heading",
          content: { level: 1, text: "Eigenvalues" },
        },
        {
          id: blockB,
          type: "paragraph",
          content: { text: "Definition and intuition." },
        },
      ],
    });

    expect(doc.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(doc.workspaceId).toBe(workspaceA);
    expect(doc.title).toBe("Linear algebra notes");
    expect(doc.lifecycle).toBe("scratch");
    expect(doc.schemaVersion).toBe(1);
    expect(doc.currentRevisionNumber).toBe(1);
    expect(doc.deletedAt).toBeNull();
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]).toMatchObject({
      id: blockA,
      type: "heading",
      position: 0,
      content: { level: 1, text: "Eigenvalues" },
    });
    expect(doc.blocks[1]).toMatchObject({
      id: blockB,
      type: "paragraph",
      position: 1,
    });

    const revisions = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revisionNumber).toBe(1);
    expect(revisions[0]?.title).toBe("Linear algebra notes");
    expect(revisions[0]?.blocks).toHaveLength(2);
    expect(revisions[0]?.blocks[0]?.id).toBe(blockA);
  });

  it("lists active workspace documents newest first with their blocks", async () => {
    const older = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Older note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "older" } }],
    });
    const newer = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Newer note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "newer" } }],
    });
    const deleted = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Deleted note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "deleted" } }],
    });
    await repo.createDocument({
      workspaceId: workspaceB,
      title: "Other workspace note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "other" } }],
    });
    await repo.softDeleteDocument({ workspaceId: workspaceA, documentId: deleted.id });
    await sql`
      UPDATE library_documents
      SET updated_at = CASE
        WHEN id = ${older.id} THEN '2026-01-01T00:00:00Z'::timestamptz
        WHEN id = ${newer.id} THEN '2026-01-02T00:00:00Z'::timestamptz
        ELSE updated_at
      END
      WHERE workspace_id = ${workspaceA}
    `;

    const documents = await repo.listDocuments({ workspaceId: workspaceA });

    expect(documents.map((document) => document.title)).toEqual([
      "Newer note",
      "Older note",
    ]);
    expect(documents[0]?.blocks[0]?.content).toEqual({ text: "newer" });
    expect(documents.every((document) => document.workspaceId === workspaceA)).toBe(true);
  });

  it("keeps block IDs stable across edits and appends a new revision", async () => {
    const blockA = randomUUID();
    const blockB = randomUUID();

    const created = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Draft",
      blocks: [
        { id: blockA, type: "paragraph", content: { text: "v1" } },
        { id: blockB, type: "paragraph", content: { text: "keep me" } },
      ],
    });

    const updated = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: created.id,
      title: "Draft v2",
      blocks: [
        { id: blockA, type: "paragraph", content: { text: "v2 edited" } },
        { id: blockB, type: "paragraph", content: { text: "keep me" } },
        {
          id: randomUUID(),
          type: "code",
          content: { language: "ts", text: "const x = 1;" },
        },
      ],
      reason: "user-edit",
    });

    expect(updated.currentRevisionNumber).toBe(2);
    expect(updated.title).toBe("Draft v2");
    expect(updated.blocks).toHaveLength(3);
    expect(updated.blocks[0]?.id).toBe(blockA);
    expect(updated.blocks[0]?.content).toEqual({ text: "v2 edited" });
    expect(updated.blocks[1]?.id).toBe(blockB);

    const revisions = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: created.id,
    });
    expect(revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);

    // Revision 1 remains recoverable and unchanged (append-only).
    const rev1 = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: created.id,
      revisionNumber: 1,
    });
    expect(rev1.title).toBe("Draft");
    expect(rev1.blocks).toHaveLength(2);
    expect(rev1.blocks[0]?.content).toEqual({ text: "v1" });
    expect(rev1.reason).toBe("create");

    const rev2 = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: created.id,
      revisionNumber: 2,
    });
    expect(rev2.title).toBe("Draft v2");
    expect(rev2.blocks).toHaveLength(3);
    expect(rev2.parentRevisionNumber).toBe(1);
    expect(rev2.reason).toBe("user-edit");
  });

  it("does not mutate historical revision rows when editing", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Immutable history",
      blocks: [{ id: blockId, type: "paragraph", content: { text: "first" } }],
    });

    const before = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: doc.id,
      revisionNumber: 1,
    });

    await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "second" } },
      ],
    });

    const after = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: doc.id,
      revisionNumber: 1,
    });

    expect(after).toEqual(before);
    expect(after.blocks[0]?.content).toEqual({ text: "first" });
  });

  it("enforces lifecycle transitions without changing an invalid document", async () => {
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Lifecycle document",
      lifecycle: "candidate",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "v1" } }],
    });

    const confirmed = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      lifecycle: "confirmed",
      blocks: doc.blocks,
      reason: "confirm",
    });
    const published = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      lifecycle: "published",
      blocks: confirmed.blocks,
      reason: "publish",
    });
    const revisionsBeforeInvalidTransition = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });

    await expect(
      repo.updateDocument({
        workspaceId: workspaceA,
        documentId: doc.id,
        lifecycle: "candidate",
        blocks: published.blocks,
        reason: "invalid-demotion",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_TRANSITION" });

    const current = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    const revisionsAfterInvalidTransition = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(current.lifecycle).toBe("published");
    expect(current.updatedAt).toEqual(published.updatedAt);
    expect(current.blocks).toEqual(published.blocks);
    expect(revisionsAfterInvalidTransition).toEqual(revisionsBeforeInvalidTransition);
  });

  it("creates typed relations between documents and blocks", async () => {
    const srcBlock = randomUUID();
    const dstBlock = randomUUID();

    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Source note",
      blocks: [
        { id: srcBlock, type: "paragraph", content: { text: "claim" } },
      ],
    });
    const target = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Target note",
      blocks: [
        { id: dstBlock, type: "paragraph", content: { text: "evidence" } },
      ],
    });

    const docLink = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "references",
    });

    const blockLink = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "block",
      fromId: srcBlock,
      toType: "block",
      toId: dstBlock,
      relationType: "supports",
    });

    const embed = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "block",
      toId: dstBlock,
      relationType: "embeds",
    });

    expect(docLink.relationType).toBe("references");
    expect(blockLink.fromId).toBe(srcBlock);
    expect(embed.toType).toBe("block");

    const listed = await repo.listRelations({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: source.id,
    });
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.relationType).sort()).toEqual([
      "embeds",
      "references",
    ]);
  });

  it("attaches typed properties to documents and blocks", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Properties",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "body" } },
      ],
    });

    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "status",
      valueType: "string",
      value: "active",
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "priority",
      valueType: "number",
      value: 3,
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "block",
      subjectId: blockId,
      key: "flagged",
      valueType: "boolean",
      value: true,
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "meta",
      valueType: "json",
      value: { tags: ["math", "core"], score: 0.9 },
    });

    // Upsert same key updates value without duplicating.
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "priority",
      valueType: "number",
      value: 5,
    });

    const props = await repo.listProperties({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
    });

    expect(props).toHaveLength(3);
    const byKey = Object.fromEntries(props.map((p) => [p.key, p]));
    expect(byKey.status).toMatchObject({
      valueType: "string",
      value: "active",
    });
    expect(byKey.priority).toMatchObject({ valueType: "number", value: 5 });
    expect(byKey.meta?.value).toEqual({ tags: ["math", "core"], score: 0.9 });

    const blockProps = await repo.listProperties({
      workspaceId: workspaceA,
      subjectType: "block",
      subjectId: blockId,
    });
    expect(blockProps).toHaveLength(1);
    expect(blockProps[0]).toMatchObject({
      key: "flagged",
      valueType: "boolean",
      value: true,
    });
  });

  it("soft-deletes and restores a document without destroying revisions", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "To archive",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "payload" } },
      ],
    });

    await repo.softDeleteDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });

    await expect(
      repo.getDocument({ workspaceId: workspaceA, documentId: doc.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      repo.getDocument({
        workspaceId: workspaceA,
        documentId: doc.id,
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({
      id: doc.id,
      deletedAt: expect.any(Date),
    });

    const revisionsWhileDeleted = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(revisionsWhileDeleted).toHaveLength(1);

    const restored = await repo.restoreDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(restored.deletedAt).toBeNull();
    expect(restored.blocks[0]?.id).toBe(blockId);

    const again = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(again.title).toBe("To archive");
  });

  it("rejects cross-workspace document access and relations", async () => {
    const blockInA = randomUUID();
    const blockInB = randomUUID();

    const docA = await repo.createDocument({
      workspaceId: workspaceA,
      title: "A only",
      blocks: [
        { id: blockInA, type: "paragraph", content: { text: "private A" } },
      ],
    });
    const docB = await repo.createDocument({
      workspaceId: workspaceB,
      title: "B only",
      blocks: [
        { id: blockInB, type: "paragraph", content: { text: "private B" } },
      ],
    });

    await expect(
      repo.getDocument({ workspaceId: workspaceB, documentId: docA.id }),
    ).rejects.toBeInstanceOf(LibraryError);

    await expect(
      repo.updateDocument({
        workspaceId: workspaceB,
        documentId: docA.id,
        title: "hijack",
        blocks: [
          { id: blockInA, type: "paragraph", content: { text: "nope" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });

    await expect(
      repo.createRelation({
        workspaceId: workspaceA,
        fromType: "document",
        fromId: docA.id,
        toType: "document",
        toId: docB.id,
        relationType: "references",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    await expect(
      repo.createRelation({
        workspaceId: workspaceA,
        fromType: "block",
        fromId: blockInA,
        toType: "block",
        toId: blockInB,
        relationType: "supports",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    await expect(
      repo.setProperty({
        workspaceId: workspaceA,
        subjectType: "document",
        subjectId: docB.id,
        key: "x",
        valueType: "string",
        value: "y",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });

    // Original content in A remains intact.
    const stillA = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: docA.id,
    });
    expect(stillA.title).toBe("A only");
    expect(stillA.blocks[0]?.content).toEqual({ text: "private A" });
  });

  it("rejects empty block lists and unknown lifecycle values", async () => {
    await expect(
      repo.createDocument({
        workspaceId: workspaceA,
        title: "Empty",
        blocks: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      repo.createDocument({
        workspaceId: workspaceA,
        title: "Bad lifecycle",
        // @ts-expect-error intentional invalid lifecycle for runtime guard
        lifecycle: "formal",
        blocks: [
          {
            id: randomUUID(),
            type: "paragraph",
            content: { text: "x" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("applies migrations idempotently (round-trip)", async () => {
    // Second apply must be a no-op success.
    const first = await applyMigrations(sql);
    const second = await applyMigrations(sql);
    expect(first.applied.length + first.alreadyApplied.length).toBeGreaterThan(
      0,
    );
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain("0001_library.sql");
  });
});
