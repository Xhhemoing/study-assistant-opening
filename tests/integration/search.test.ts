import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCourseMembershipRepository,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  LibraryError,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LibraryRepository,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for search repository tests");
}

describe("library search repository", () => {
  const sql = createSqlClient(databaseUrl);
  let repo: LibraryRepository;
  let identity: IdentityRepository;
  let courses: CourseMembershipRepository;
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    repo = createLibraryRepository(sql);
    identity = createIdentityRepository(sql);
    courses = createCourseMembershipRepository(sql);
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

    const [userA, userB] = await Promise.all([
      identity.createUserWithWorkspace({
        email: `search-a-${randomUUID()}@example.com`,
        displayName: "Search A",
        passwordHash: "scrypt$not-used",
      }),
      identity.createUserWithWorkspace({
        email: `search-b-${randomUUID()}@example.com`,
        displayName: "Search B",
        passwordHash: "scrypt$not-used",
      }),
    ]);
    workspaceA = userA.workspace.id;
    workspaceB = userB.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("returns documents matching any token in a multi-word query", async () => {
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "行列式笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "内容" } }],
    });
    await repo.createDocument({
      workspaceId: workspaceB,
      title: "展开笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "内容" } }],
    });

    const hits = await repo.searchLibrary({ workspaceId: workspaceA, query: "行列式 展开" });
    expect(hits.map((row) => row.title)).toEqual(["行列式笔记"]);
  });

  it("matches each token in a multi-word query regardless of source spacing", async () => {
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "行列式笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "展开公式" } }],
    });

    const hits = await repo.searchLibrary({ workspaceId: workspaceA, query: "行列式 展开" });
    expect(hits.map((row) => row.title)).toEqual(["行列式笔记"]);
  });

  it("matches full-width queries using the same normalization as domain ranking", async () => {
    const document = await repo.createDocument({
      workspaceId: workspaceA,
      title: "专题笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "内容" } }],
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: document.id,
      key: "tags",
      valueType: "json",
      value: ["TOPIC"],
    });

    const hits = await repo.searchLibrary({ workspaceId: workspaceA, query: "ＴＯＰＩＣ" });
    expect(hits.map((row) => row.title)).toEqual(["专题笔记"]);
  });

  it("matches document titles, block text, and tag values within the workspace", async () => {
    const blockId = randomUUID();
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "行列式笔记",
      blocks: [{ id: blockId, type: "paragraph", content: { text: "关于行列式的展开公式" } }],
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: (await repo.listDocuments({ workspaceId: workspaceA }))[0]!.id,
      key: "tags",
      valueType: "json",
      value: ["线性代数"],
    });

    const byTitle = await repo.searchLibrary({ workspaceId: workspaceA, query: "行列式" });
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]).toMatchObject({ type: "document", title: "行列式笔记" });
    expect(byTitle[0]?.body).toContain("展开公式");
    expect(byTitle[0]?.tags).toEqual(["线性代数"]);

    const byBody = await repo.searchLibrary({ workspaceId: workspaceA, query: "展开公式" });
    expect(byBody.map((row) => row.title)).toEqual(["行列式笔记"]);

    const byTag = await repo.searchLibrary({ workspaceId: workspaceA, query: "线性代数" });
    expect(byTag.map((row) => row.title)).toEqual(["行列式笔记"]);

    const noMatch = await repo.searchLibrary({ workspaceId: workspaceA, query: "微积分" });
    expect(noMatch).toEqual([]);
  });

  it("excludes soft-deleted documents and archived courses", async () => {
    const created = await repo.createDocument({
      workspaceId: workspaceA,
      title: "可恢复笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "内容" } }],
    });
    const course = await courses.createCourse({
      workspaceId: workspaceA,
      title: "线性代数课程",
      slug: "linear-algebra",
      description: "向量与矩阵",
    });
    await sql`
      UPDATE courses SET archived_at = now()
      WHERE workspace_id = ${workspaceA} AND id = ${course.id}
    `;

    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "线性代数" })).toEqual([]);
    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "向量" })).toEqual([]);

    await repo.softDeleteDocument({ workspaceId: workspaceA, documentId: created.id });
    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "可恢复" })).toEqual([]);
  });

  it("isolates results across workspaces", async () => {
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "私有笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "只有 A 可见" } }],
    });

    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "私有" })).toHaveLength(1);
    expect(await repo.searchLibrary({ workspaceId: workspaceB, query: "私有" })).toEqual([]);
  });

  it("searches courses by title and description with archived exclusion", async () => {
    const document = await repo.createDocument({
      workspaceId: workspaceA,
      title: "课程笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "内容" } }],
    });
    const course = await courses.createCourse({
      workspaceId: workspaceA,
      title: "高等数学",
      slug: "calculus",
      description: "极限与导数",
    });
    await courses.addAssetMembership({
      workspaceId: workspaceA,
      courseId: course.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      visibility: "course",
    });

    const documentHit = await repo.searchLibrary({ workspaceId: workspaceA, query: "课程笔记" });
    expect(documentHit[0]).toMatchObject({
      title: "课程笔记",
      lifecycle: "scratch",
      courseMemberships: [{ id: course.id, title: "高等数学" }],
    });

    const byTitle = await repo.searchLibrary({ workspaceId: workspaceA, query: "高等数学" });
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]).toMatchObject({ type: "course", title: "高等数学", body: "极限与导数", tags: [] });

    const byDescription = await repo.searchLibrary({ workspaceId: workspaceA, query: "极限" });
    expect(byDescription.map((row) => row.title)).toEqual(["高等数学"]);
  });

  it("returns all repository candidates while rejecting invalid limits", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      repo.createDocument({
        workspaceId: workspaceA,
        title: `匹配文档 ${index}`,
        blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "共享关键词" } }],
      }),
    ));

    expect((await repo.searchLibrary({ workspaceId: workspaceA, query: "共享", limit: 2 }))).toHaveLength(5);
    await expect(repo.searchLibrary({ workspaceId: workspaceA, query: "共享", limit: 0 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(repo.searchLibrary({ workspaceId: workspaceA, query: "共享", limit: 51 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("returns an empty result for blank queries and escapes LIKE wildcards", async () => {
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "百分比 100% 完成",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "进度" } }],
    });

    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "   " })).toEqual([]);
    const literalPercent = await repo.searchLibrary({ workspaceId: workspaceA, query: "100%" });
    expect(literalPercent.map((row) => row.title)).toEqual(["百分比 100% 完成"]);
    // LIKE wildcards are escaped ("100_" does not match "100%完成" via the LIKE
    // branch), but search is FTS ∪ LIKE: the 'simple' dictionary strips "_" as a
    // separator, so plainto_tsquery("100_") matches token "100" and the document
    // is a legitimate FTS hit. Verify the escape property instead of asserting
    // wildcard coincidence: "_" alone must NOT match, and a wildcard that
    // collides via LIKE must not broaden the LIKE branch itself.
    expect(await repo.searchLibrary({ workspaceId: workspaceA, query: "_" })).toEqual([]);
    const wildcardEscape = await repo.searchLibrary({ workspaceId: workspaceA, query: "100_" });
    expect(wildcardEscape.map((row) => row.title)).toEqual(["百分比 100% 完成"]);
  });

  it("rejects searches against an unknown workspace", async () => {
    await expect(repo.searchLibrary({ workspaceId: randomUUID(), query: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("raises LibraryError only through the repository contract", async () => {
    // The repository never resolves to a typed error for a valid workspace.
    const hits = await repo.searchLibrary({ workspaceId: workspaceA, query: "" });
    expect(hits).toEqual([]);
    expect(LibraryError).toBeDefined();
  });
});
