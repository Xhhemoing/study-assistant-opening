import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assetGraphPageSchema, type AssetGraphQuery, type KnowledgeSnapshot } from "@aistudy/contracts";
import { hashSessionToken } from "@aistudy/database";
import { backupRows } from "../opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { createSessionJwt } from "../../../apps/web/src/lib/session";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as queryAssetGraph } from "../../../apps/web/src/app/api/opening/asset-graph/query/route";
import { POST as createLearningGoal } from "../../../apps/web/src/app/api/opening/learning-goals/route";
import { POST as saveStudyNote } from "../../../apps/web/src/app/api/opening/study-notes/route";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
let otherCookie = "";

beforeAll(async () => {
  f = await createOpeningFixture();
  const authSecret = process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret";
  runtime = createAuthRuntime({
    databaseUrl: process.env.DATABASE_URL!,
    authSecret,
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);

  const otherSessionId = randomUUID();
  const otherToken = await createSessionJwt(
    { sub: f.otherScope.ownerUserId, workspaceId: f.otherScope.workspaceId, sid: otherSessionId },
    authSecret,
    3600,
  );
  await f.sql`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (${otherSessionId}, ${f.otherScope.ownerUserId}, ${hashSessionToken(otherToken)}, now() + interval '1 hour')
  `;
  otherCookie = `aistudy_session=${otherToken}`;
});

afterAll(async () => {
  try {
    setAuthRuntimeForTests(null);
    await runtime?.close();
  } finally {
    await f?.close();
  }
});

function jsonRequest(url: string, body: unknown, cookie = f.cookie): Request {
  return new Request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postQuery(body: unknown, cookie = f.cookie): Promise<Response> {
  const response = await queryAssetGraph(
    jsonRequest("http://localhost/api/opening/asset-graph/query", body, cookie),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response;
}

describe("POST /api/opening/asset-graph/query handler integration", () => {
  it("projects opt-in knowledge evidence with real SQL scope and preserves legacy HTTP responses through rollback", async () => {
    const { sql, scope } = f;
    const course = randomUUID();
    const [start, target, partial, suggestion] = Array.from({ length: 4 }, () => randomUUID());
    await sql`INSERT INTO courses (id,workspace_id,title,slug) VALUES (${course},${scope.workspaceId},'知识边验收',${course})`;
    const goalResponse = await createLearningGoal(jsonRequest("http://localhost/api/opening/learning-goals", {
      courseIds: [course], title: "核对知识边", kind: "custom", targetDate: "2027-03-01",
      examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "auto",
      successCriteria: "用本目标可见材料验证", clientKey: randomUUID(),
    }));
    expect(goalResponse.status).toBe(200);
    const { id: goal } = await goalResponse.json() as { id: string };
    const seeds = backupRows(sql, scope);
    const teaching = await seeds.source();
    const otherTeaching = await seeds.source();
    const hidden = await seeds.source();
    const visibleChunk = await seeds.chunk(teaching);
    const otherChunk = await seeds.chunk(otherTeaching);
    const hiddenChunk = await seeds.chunk(hidden);
    const expectedRefs = [
      { sourceId: teaching, sourceVersion: 1, chunkId: visibleChunk, page: 1 },
      { sourceId: otherTeaching, sourceVersion: 1, chunkId: otherChunk, page: 1 },
    ].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const primaryRef = expectedRefs[0]!, secondaryRef = expectedRefs[1]!;
    for (const source of [teaching, otherTeaching, hidden]) {
      await sql`INSERT INTO opening_source_versions (source_id,version,workspace_id,bytes,sha256,availability)
        VALUES (${source},1,${scope.workspaceId},21,${"a".repeat(64)},'available')`;
      await sql`INSERT INTO course_asset_memberships (workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
        VALUES (${scope.workspaceId},${course},'source',${source},'core','course','teaching')`;
    }

    const nodeIds = [start!, target!, partial!, suggestion!];
    const snapshot: KnowledgeSnapshot = {
      courseId: course, version: 1,
      nodes: nodeIds.map((id, index) => ({
        id, courseId: course, label: `概念 ${index + 1}`, kind: "concept",
        status: "supported", evidenceChunkIds: [visibleChunk],
      })),
      edges: [
        { from: start!, to: target!, kind: "prerequisite", status: "supported", evidenceChunkIds: [secondaryRef.chunkId] },
        { from: start!, to: target!, kind: "prerequisite", status: "supported", evidenceChunkIds: [primaryRef.chunkId] },
        { from: start!, to: partial!, kind: "contains", status: "supported", evidenceChunkIds: [visibleChunk, hiddenChunk] },
        { from: start!, to: suggestion!, kind: "applies_to", status: "suggested", evidenceChunkIds: [visibleChunk] },
      ],
    };
    await sql`INSERT INTO opening_course_knowledge (workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES (${scope.workspaceId},${scope.ownerUserId},${course},1,${sql.json(snapshot)},${sql.json({ [teaching]: 1, [otherTeaching]: 1, [hidden]: 1 })})`;
    const verification = { kind: "manual", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] };
    for (const [position, node] of nodeIds.entries()) {
      const sourceRefs = position === 0 ? expectedRefs : [];
      await sql`INSERT INTO course_requirements (
        id,workspace_id,owner_user_id,course_id,stable_skill_id,knowledge_node_id,requirement_key,title,
        position,mandatory,goal_ids,prerequisite_ids,source_refs,verification,revision,lifecycle,origin,approved_at
      ) VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${course},${randomUUID()},${node},
        ${`concept-${position}`},${`要求 ${position}`},${position},true,${[goal]}::uuid[],'{}'::uuid[],
        ${sql.json(sourceRefs)},${sql.json(verification)},1,'active','confirmed',now())`;
    }

    const context = { kind: "goal", id: `goal/${goal}` } as const;
    const query = {
      op: "neighbors", context, lens: "structure", focus: `knowledge/${course}/${start}`, direction: "out",
    } as const satisfies AssetGraphQuery;
    const optIn = { ...query, includeKnowledgeEdgeDetails: true };
    const page = async (body: AssetGraphQuery) => {
      const response = await postQuery(body);
      expect(response.status).toBe(200);
      return assetGraphPageSchema.parse(await response.json());
    };
    const assertLegacy = (edges: Awaited<ReturnType<typeof page>>["edges"]) => {
      expect(edges).toHaveLength(3);
      expect(edges.map(edge => Object.keys(edge).sort())).toEqual(
        Array.from({ length: 3 }, () => ["basis", "from", "id", "relation", "to"]),
      );
    };

    vi.stubEnv("OPENING_ASSET_GRAPH_KNOWLEDGE_EDGE_DETAILS", "");
    try {
      const legacy = await page(query);
      assertLegacy(legacy.edges);
      expect(legacy.nodes[0]?.meta?.knowledgeStatus).toBe("supported");
      const enriched = await page(optIn);
      const edges = Object.fromEntries(enriched.edges.map(edge => [edge.relation, edge]));
      expect(edges.prerequisite).toMatchObject({
        knowledgeStatus: "supported", sourceNodeId: `source/${primaryRef.sourceId}`, sourceVersion: 1, page: 1,
      });
      expect(edges.prerequisite?.evidenceRefs).toEqual(expectedRefs);
      expect(edges.prerequisite).not.toHaveProperty("confidence");
      expect(edges.contains).toMatchObject({ knowledgeStatus: "needs_check", evidenceRefs: [] });
      expect(edges.contains).not.toHaveProperty("sourceNodeId");
      expect(edges.appliesTo).toMatchObject({ knowledgeStatus: "suggested", evidenceRefs: [] });
      expect(edges.appliesTo).not.toHaveProperty("sourceNodeId");
      const hiddenDetail = await postQuery({ op: "detail", context, lens: "all", focus: `source/${hidden}` });
      expect(hiddenDetail.status).toBe(404);

      const paged = { ...optIn, limit: 1 };
      const cursor = (await page(paged)).page.nextCursor!;
      expect(cursor).toBeTruthy();
      const evidenceQuery = { op: "roots", lens: "evidence", context, limit: 1, includeKnowledgeEdgeDetails: true } as const;
      const evidenceCursor = (await page(evidenceQuery)).page.nextCursor!;
      expect(evidenceCursor).toBeTruthy();
      await sql`UPDATE opening_sources SET version=version+1, updated_at=now() WHERE id=${hidden}`;
      await page({ ...paged, cursor });
      await page({ ...evidenceQuery, cursor: evidenceCursor });

      await sql`UPDATE opening_source_chunks SET page=2 WHERE id=${secondaryRef.chunkId}`;
      const changed = await postQuery({ ...paged, cursor });
      expect(changed.status).toBe(409);
      await expect(changed.json()).resolves.toMatchObject({ error: { code: "CURSOR_STALE" } });
      await page({ ...evidenceQuery, cursor: evidenceCursor });

      const remainingRef = { ...secondaryRef, page: 2 };
      const expectRemainingEvidence = async () => {
        expect((await page(optIn)).edges.find(edge => edge.relation === "prerequisite")).toMatchObject({
          knowledgeStatus: "supported", sourceNodeId: `source/${remainingRef.sourceId}`, page: 2,
          evidenceRefs: [remainingRef],
        });
      };
      await sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${primaryRef.sourceId}`;
      await expectRemainingEvidence();
      await sql`UPDATE opening_sources SET upload_state='uploaded', parse_state='queued' WHERE id=${primaryRef.sourceId}`;
      await expectRemainingEvidence();
      await sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${primaryRef.sourceId}`;

      const rollbackCursor = (await page(paged)).page.nextCursor!;
      vi.stubEnv("OPENING_ASSET_GRAPH_KNOWLEDGE_EDGE_DETAILS", "off");
      const rolledBack = await page(optIn);
      assertLegacy(rolledBack.edges);
      expect(rolledBack.edges).toEqual(legacy.edges);
      const stale = await postQuery({ ...paged, cursor: rollbackCursor });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ error: { code: "CURSOR_STALE" } });

      await sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${course} AND asset_id=${hidden}`;
      expect((await postQuery(optIn)).status).toBe(404);
      await sql`UPDATE course_asset_memberships SET purpose='teaching' WHERE course_id=${course} AND asset_id=${hidden}`;
      await sql`INSERT INTO opening_privacy_exclusions (workspace_id,source_id,deleted_at,asset_deleted_at)
        VALUES (${scope.workspaceId},${hidden},now(),now())`;
      expect((await postQuery(optIn)).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires real cookie auth and rejects malformed/oversized/invalid payloads", async () => {
    const unauth = await postQuery(
      { op: "roots", context: { kind: "workspace" }, lens: "all" },
      "",
    );
    expect(unauth.status).toBe(401);
    await expect(unauth.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const invalidCookie = await postQuery(
      { op: "roots", context: { kind: "workspace" }, lens: "all" },
      "aistudy_session=invalid.jwt.token",
    );
    expect(invalidCookie.status).toBe(401);

    const badJson = await postQuery("{bad-json");
    expect(badJson.status).toBe(400);
    await expect(badJson.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });

    const observationRoot = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      kinds: ["observation"],
    });
    expect(observationRoot.status).toBe(400);
    await expect(observationRoot.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });

    const injectedScope = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      workspaceId: f.otherScope.workspaceId,
    });
    expect(injectedScope.status).toBe(400);
    await expect(injectedScope.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });

    const tooLarge = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      q: "x".repeat(16_500),
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("queries real courses, goals, requirements, and unscoped notes while isolating foreign workspaces with unified 404", async () => {
    const ownCourseId = randomUUID();
    const ownCourseTwoId = randomUUID();
    const foreignCourseId = randomUUID();
    await f.sql`
      INSERT INTO courses (id, workspace_id, title, slug) VALUES
        (${ownCourseId}, ${f.scope.workspaceId}, '线性代数', ${ownCourseId}),
        (${ownCourseTwoId}, ${f.scope.workspaceId}, '概率论', ${ownCourseTwoId}),
        (${foreignCourseId}, ${f.otherScope.workspaceId}, '他人课程', ${foreignCourseId})
    `;

    const ownGoalRes = await createLearningGoal(
      jsonRequest("http://localhost/api/opening/learning-goals", {
        courseIds: [ownCourseId],
        title: "掌握矩阵分解",
        kind: "custom",
        targetDate: "2027-03-01",
        examDate: null,
        weeklyMinutes: 120,
        priority: 1,
        learningMode: "auto",
        successCriteria: "独立完成基础证明与计算",
        clientKey: randomUUID(),
      }),
    );
    expect(ownGoalRes.status).toBe(200);
    const ownGoal = (await ownGoalRes.json()) as { id: string };

    const foreignGoalRes = await createLearningGoal(
      jsonRequest(
        "http://localhost/api/opening/learning-goals",
        {
          courseIds: [foreignCourseId],
          title: "他人学习目标",
          kind: "custom",
          targetDate: "2027-03-01",
          examDate: null,
          weeklyMinutes: 60,
          priority: 1,
          learningMode: "auto",
          successCriteria: "他人目标标准",
          clientKey: randomUUID(),
        },
        otherCookie,
      ),
    );
    expect(foreignGoalRes.status).toBe(200);
    const foreignGoal = (await foreignGoalRes.json()) as { id: string };

    const reqId = randomUUID();
    const verification = {
      kind: "manual",
      status: "missing",
      exerciseKeys: [],
      rubric: null,
      missingReasons: [],
    };
    await f.sql`
      INSERT INTO course_requirements (
        id, workspace_id, owner_user_id, course_id, stable_skill_id, knowledge_node_id,
        requirement_key, title, position, mandatory, goal_ids, prerequisite_ids,
        source_refs, verification, revision, lifecycle, origin, approved_at
      ) VALUES (
        ${reqId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${ownCourseId},
        ${randomUUID()}, ${null}, 'req:matrix-rank', '理解矩阵秩与线性无关',
        0, true, ${[ownGoal.id]}::uuid[], '{}'::uuid[], '[]'::jsonb,
        ${f.sql.json(verification)}, 1, 'active', 'confirmed', now()
      )
    `;

    const unscopedNoteRes = await saveStudyNote(
      jsonRequest("http://localhost/api/opening/study-notes", {
        clientKey: randomUUID(),
        title: "无课独立思考笔记",
        text: "只记录个人理解，不关联课程。",
        courseId: null,
        goalId: null,
        requirementId: null,
        purpose: "exploration",
        origin: null,
      }),
    );
    expect(unscopedNoteRes.status).toBe(200);
    const unscopedNote = (await unscopedNoteRes.json()) as { documentId: string };

    const foreignNoteRes = await saveStudyNote(
      jsonRequest(
        "http://localhost/api/opening/study-notes",
        {
          clientKey: randomUUID(),
          title: "他人私密笔记",
          text: "不应该被本账户查询到。",
          courseId: null,
          goalId: null,
          requirementId: null,
          purpose: "exploration",
          origin: null,
        },
        otherCookie,
      ),
    );
    expect(foreignNoteRes.status).toBe(200);
    const foreignNote = (await foreignNoteRes.json()) as { documentId: string };

    // 1. Workspace roots include own courses, goal, and unscoped note, never foreign assets
    const wsRootsRes = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
    });
    expect(wsRootsRes.status).toBe(200);
    const wsRoots = assetGraphPageSchema.parse(await wsRootsRes.json());
    const wsNodeIds = wsRoots.nodes.map(node => node.id);
    expect(wsNodeIds).toContain(`course/${ownCourseId}`);
    expect(wsNodeIds).toContain(`course/${ownCourseTwoId}`);
    expect(wsNodeIds).toContain(`goal/${ownGoal.id}`);
    expect(wsNodeIds).toContain(`document/${unscopedNote.documentId}`);
    expect(wsNodeIds).not.toContain(`course/${foreignCourseId}`);
    expect(wsNodeIds).not.toContain(`goal/${foreignGoal.id}`);
    expect(wsNodeIds).not.toContain(`document/${foreignNote.documentId}`);

    // 2. Course-scoped roots exclude unscoped workspace notes
    const courseRootsRes = await postQuery({
      op: "roots",
      context: { kind: "course", id: `course/${ownCourseId}` },
      lens: "structure",
    });
    expect(courseRootsRes.status).toBe(200);
    const courseRoots = assetGraphPageSchema.parse(await courseRootsRes.json());
    expect(courseRoots.nodes.map(n => n.id)).toEqual(
      expect.arrayContaining([
        `course/${ownCourseId}`,
        `goal/${ownGoal.id}`,
        `requirement/${reqId}`,
      ]),
    );
    expect(courseRoots.nodes.map(n => n.id)).not.toContain(`document/${unscopedNote.documentId}`);
    expect(courseRoots.nodes.map(n => n.id)).not.toContain(`course/${ownCourseTwoId}`);

    // 3. Goal-scoped neighbors trace goal -> requirement
    const goalNeighborsRes = await postQuery({
      op: "neighbors",
      context: { kind: "goal", id: `goal/${ownGoal.id}` },
      lens: "structure",
      focus: `goal/${ownGoal.id}`,
      direction: "out",
      include: ["summary"],
    });
    expect(goalNeighborsRes.status).toBe(200);
    const goalNeighbors = assetGraphPageSchema.parse(await goalNeighborsRes.json());
    expect(goalNeighbors.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `goal/${ownGoal.id}`,
          to: `requirement/${reqId}`,
          relation: "scopes",
          basis: "recorded",
        }),
      ]),
    );

    // 4. Unscoped note detail returns safe opening navigation action
    const noteDetailRes = await postQuery({
      op: "detail",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `document/${unscopedNote.documentId}`,
    });
    expect(noteDetailRes.status).toBe(200);
    const noteDetail = assetGraphPageSchema.parse(await noteDetailRes.json());
    expect(noteDetail.detail).toMatchObject({
      id: `document/${unscopedNote.documentId}`,
      actions: [
        {
          kind: "navigate",
          href: `/opening/library/${unscopedNote.documentId}`,
        },
      ],
    });

    // 5. Cross-account and out-of-scope queries return unified 404 "请求的资源不可用。"
    const crossAccountQueries = [
      { op: "roots", context: { kind: "course", id: `course/${foreignCourseId}` }, lens: "all" },
      { op: "roots", context: { kind: "goal", id: `goal/${foreignGoal.id}` }, lens: "all" },
      {
        op: "detail",
        context: { kind: "workspace" },
        lens: "all",
        focus: `document/${foreignNote.documentId}`,
      },
      {
        op: "neighbors",
        context: { kind: "course", id: `course/${ownCourseId}` },
        lens: "all",
        focus: `document/${unscopedNote.documentId}`,
        direction: "both",
      },
    ];
    for (const query of crossAccountQueries) {
      const res = await postQuery(query);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: { code: "NOT_FOUND", message: "请求的资源不可用。" },
      });
    }

    // 6. Pagination cursor validation: tampered cursor & privacy_epoch bump both return 409 CURSOR_STALE
    const page1Res = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
    });
    expect(page1Res.status).toBe(200);
    const page1 = assetGraphPageSchema.parse(await page1Res.json());
    expect(page1.nodes).toHaveLength(1);
    expect(page1.page.nextCursor).toBeTruthy();

    const validCursor = page1.page.nextCursor!;
    const tamperedCursor = `${validCursor.slice(0, -1)}${validCursor.endsWith("A") ? "B" : "A"}`;
    const tamperedRes = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
      cursor: tamperedCursor,
    });
    expect(tamperedRes.status).toBe(409);
    await expect(tamperedRes.json()).resolves.toMatchObject({
      error: { code: "CURSOR_STALE" },
    });

    const page2Res = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
      cursor: validCursor,
    });
    expect(page2Res.status).toBe(200);
    const page2 = assetGraphPageSchema.parse(await page2Res.json());
    expect(page2.nodes).toHaveLength(1);
    expect(page2.nodes[0]!.id).not.toBe(page1.nodes[0]!.id);

    await f.sql`UPDATE workspaces SET privacy_epoch = privacy_epoch + 1 WHERE id = ${f.scope.workspaceId}`;
    const staleAfterPrivacyRes = await postQuery({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
      cursor: validCursor,
    });
    expect(staleAfterPrivacyRes.status).toBe(409);
    await expect(staleAfterPrivacyRes.json()).resolves.toMatchObject({
      error: { code: "CURSOR_STALE" },
    });
  });
});
