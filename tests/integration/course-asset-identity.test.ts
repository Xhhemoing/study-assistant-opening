import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCourseMembershipRepository,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  CourseMembershipError,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LibraryRepository,
} from "@aistudy/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy";

describe("course asset identity invariant", () => {
  const sql = createSqlClient(databaseUrl);
  let library: LibraryRepository;
  let courses: CourseMembershipRepository;
  let identity: IdentityRepository;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    library = createLibraryRepository(sql);
    courses = createCourseMembershipRepository(sql);
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
      email: `course-a-${randomUUID()}@example.com`,
      displayName: "Course A",
      passwordHash: "scrypt$not-used",
    });
    const userB = await identity.createUserWithWorkspace({
      email: `course-b-${randomUUID()}@example.com`,
      displayName: "Course B",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = userA.workspace.id;
    otherWorkspaceId = userB.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("shares one document identity across courses; membership never copies content", async () => {
    const blockId = randomUUID();

    // 1. Create one document (workspace-scoped asset identity).
    const document = await library.createDocument({
      workspaceId,
      title: "Shared linear algebra note",
      lifecycle: "confirmed",
      blocks: [
        {
          id: blockId,
          type: "paragraph",
          content: { text: "eigenvalues v1" },
        },
      ],
    });

    // 2. Create Course A and Course B; add the same document to both.
    const courseA = await courses.createCourse({
      workspaceId,
      title: "Math 101",
      slug: "math-101",
    });
    const courseB = await courses.createCourse({
      workspaceId,
      title: "Exam Prep 2026",
      slug: "exam-prep-2026",
    });

    const membershipA = await courses.addAssetMembership({
      workspaceId,
      courseId: courseA.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      sortOrder: 10,
      visibility: "course",
    });
    const membershipB = await courses.addAssetMembership({
      workspaceId,
      courseId: courseB.id,
      assetType: "document",
      assetId: document.id,
      role: "reference",
      sortOrder: 20,
      visibility: "private",
    });

    expect(membershipA.assetId).toBe(document.id);
    expect(membershipB.assetId).toBe(document.id);
    expect(membershipA.id).not.toBe(membershipB.id);
    // Membership metadata differs per course; content is not stored on membership.
    expect(membershipA).not.toHaveProperty("title");
    expect(membershipA).not.toHaveProperty("blocks");
    expect(membershipA.role).toBe("core");
    expect(membershipB.role).toBe("reference");
    expect(membershipA.visibility).toBe("course");
    expect(membershipB.visibility).toBe("private");

    // 3. Edit the document "through Course A" (same shared document id).
    const updated = await library.updateDocument({
      workspaceId,
      documentId: document.id,
      title: "Shared linear algebra note (revised)",
      blocks: [
        {
          id: blockId,
          type: "paragraph",
          content: { text: "eigenvalues v2 — edited via course A context" },
        },
      ],
      reason: "edit-via-course-a",
    });
    expect(updated.currentRevisionNumber).toBe(2);
    expect(updated.id).toBe(document.id);

    // 4. Course B sees the same updated asset (same id + content), not a copy.
    const assetsInB = await courses.listCourseAssets({
      workspaceId,
      courseId: courseB.id,
    });
    expect(assetsInB).toHaveLength(1);
    expect(assetsInB[0]?.assetId).toBe(document.id);
    expect(assetsInB[0]?.assetType).toBe("document");
    expect(assetsInB[0]?.document?.id).toBe(document.id);
    expect(assetsInB[0]?.document?.title).toBe(
      "Shared linear algebra note (revised)",
    );
    expect(assetsInB[0]?.document?.blocks[0]?.content).toEqual({
      text: "eigenvalues v2 — edited via course A context",
    });
    expect(assetsInB[0]?.document?.currentRevisionNumber).toBe(2);

    // Direct get by id still one row — identity is unique at workspace level.
    const again = await library.getDocument({
      workspaceId,
      documentId: document.id,
    });
    expect(again.blocks[0]?.id).toBe(blockId);

    // Membership rows still point at the same assetId after content edit.
    const memAAfter = await courses.getMembership({
      workspaceId,
      courseId: courseA.id,
      assetType: "document",
      assetId: document.id,
    });
    const memBAfter = await courses.getMembership({
      workspaceId,
      courseId: courseB.id,
      assetType: "document",
      assetId: document.id,
    });
    expect(memAAfter.assetId).toBe(document.id);
    expect(memBAfter.assetId).toBe(document.id);
    expect(memAAfter.role).toBe("core");
    expect(memBAfter.role).toBe("reference");

    // 5. Remove membership from Course A only.
    await courses.removeAssetMembership({
      workspaceId,
      courseId: courseA.id,
      assetType: "document",
      assetId: document.id,
    });

    const assetsInA = await courses.listCourseAssets({
      workspaceId,
      courseId: courseA.id,
    });
    expect(assetsInA).toHaveLength(0);

    // 6. Asset and Course B membership remain; content still shared identity.
    const stillB = await courses.listCourseAssets({
      workspaceId,
      courseId: courseB.id,
    });
    expect(stillB).toHaveLength(1);
    expect(stillB[0]?.assetId).toBe(document.id);

    const survivingDoc = await library.getDocument({
      workspaceId,
      documentId: document.id,
    });
    expect(survivingDoc.title).toBe("Shared linear algebra note (revised)");
    expect(survivingDoc.deletedAt).toBeNull();
    expect(survivingDoc.blocks[0]?.content).toEqual({
      text: "eigenvalues v2 — edited via course A context",
    });

    // Revisions history remains intact after membership removal.
    const revisions = await library.listRevisions({
      workspaceId,
      documentId: document.id,
    });
    expect(revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);
  });

  it("rejects duplicate membership and cross-workspace course/asset links", async () => {
    const blockId = randomUUID();
    const document = await library.createDocument({
      workspaceId,
      title: "Local doc",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "only here" } },
      ],
    });

    const foreignDoc = await library.createDocument({
      workspaceId: otherWorkspaceId,
      title: "Foreign doc",
      blocks: [
        {
          id: randomUUID(),
          type: "paragraph",
          content: { text: "other workspace" },
        },
      ],
    });

    const course = await courses.createCourse({
      workspaceId,
      title: "Main course",
      slug: "main",
    });

    await courses.addAssetMembership({
      workspaceId,
      courseId: course.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      sortOrder: 0,
      visibility: "course",
    });

    await expect(
      courses.addAssetMembership({
        workspaceId,
        courseId: course.id,
        assetType: "document",
        assetId: document.id,
        role: "core",
        sortOrder: 1,
        visibility: "course",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_MEMBERSHIP" });

    await expect(
      courses.addAssetMembership({
        workspaceId,
        courseId: course.id,
        assetType: "document",
        assetId: foreignDoc.id,
        role: "core",
        sortOrder: 2,
        visibility: "course",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    // Course in other workspace cannot claim this workspace's document.
    const foreignCourse = await courses.createCourse({
      workspaceId: otherWorkspaceId,
      title: "Foreign course",
      slug: "foreign",
    });

    await expect(
      courses.addAssetMembership({
        workspaceId: otherWorkspaceId,
        courseId: foreignCourse.id,
        assetType: "document",
        assetId: document.id,
        role: "core",
        sortOrder: 0,
        visibility: "course",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    await expect(
      courses.addAssetMembership({
        workspaceId: otherWorkspaceId,
        courseId: course.id,
        assetType: "document",
        assetId: document.id,
        role: "core",
        sortOrder: 0,
        visibility: "course",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });

  it("lists courses that reference an asset without duplicating the document row", async () => {
    const document = await library.createDocument({
      workspaceId,
      title: "Multi-course asset",
      blocks: [
        {
          id: randomUUID(),
          type: "paragraph",
          content: { text: "one identity" },
        },
      ],
    });

    const courseA = await courses.createCourse({
      workspaceId,
      title: "A",
      slug: "a",
    });
    const courseB = await courses.createCourse({
      workspaceId,
      title: "B",
      slug: "b",
    });
    const courseC = await courses.createCourse({
      workspaceId,
      title: "C",
      slug: "c",
    });

    await courses.addAssetMembership({
      workspaceId,
      courseId: courseA.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      sortOrder: 0,
      visibility: "course",
    });
    await courses.addAssetMembership({
      workspaceId,
      courseId: courseC.id,
      assetType: "document",
      assetId: document.id,
      role: "optional",
      sortOrder: 5,
      visibility: "public",
    });

    const linked = await courses.listCoursesForAsset({
      workspaceId,
      assetType: "document",
      assetId: document.id,
    });

    expect(linked.map((c) => c.courseId).sort()).toEqual(
      [courseA.id, courseC.id].sort(),
    );
    expect(linked.find((c) => c.courseId === courseB.id)).toBeUndefined();

    // Still exactly one document projection row.
    const rows = await sql`
      SELECT count(*)::int AS n
      FROM library_documents
      WHERE id = ${document.id}
    `;
    expect(rows[0]?.n).toBe(1);
  });

  it("updates course-local membership metadata without rewriting asset content", async () => {
    const blockId = randomUUID();
    const document = await library.createDocument({
      workspaceId,
      title: "Stable content",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "unchanged" } },
      ],
    });
    const course = await courses.createCourse({
      workspaceId,
      title: "Ordering course",
      slug: "order",
    });

    await courses.addAssetMembership({
      workspaceId,
      courseId: course.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      sortOrder: 1,
      visibility: "course",
    });

    const updatedMembership = await courses.updateAssetMembership({
      workspaceId,
      courseId: course.id,
      assetType: "document",
      assetId: document.id,
      role: "optional",
      sortOrder: 99,
      visibility: "private",
    });

    expect(updatedMembership.role).toBe("optional");
    expect(updatedMembership.sortOrder).toBe(99);
    expect(updatedMembership.visibility).toBe("private");

    const doc = await library.getDocument({
      workspaceId,
      documentId: document.id,
    });
    expect(doc.title).toBe("Stable content");
    expect(doc.blocks[0]?.content).toEqual({ text: "unchanged" });
    expect(doc.currentRevisionNumber).toBe(1);
  });

  it("rejects invalid role/visibility and missing assets", async () => {
    const course = await courses.createCourse({
      workspaceId,
      title: "Validation course",
      slug: "validation",
    });

    await expect(
      courses.addAssetMembership({
        workspaceId,
        courseId: course.id,
        assetType: "document",
        assetId: randomUUID(),
        role: "core",
        sortOrder: 0,
        visibility: "course",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const document = await library.createDocument({
      workspaceId,
      title: "Ok",
      blocks: [
        {
          id: randomUUID(),
          type: "paragraph",
          content: { text: "x" },
        },
      ],
    });

    await expect(
      courses.addAssetMembership({
        workspaceId,
        courseId: course.id,
        assetType: "document",
        assetId: document.id,
        // @ts-expect-error intentional invalid role
        role: "owner",
        sortOrder: 0,
        visibility: "course",
      }),
    ).rejects.toBeInstanceOf(CourseMembershipError);

    await expect(
      courses.createCourse({
        workspaceId,
        title: "dup",
        slug: "validation",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
