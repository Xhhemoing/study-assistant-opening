import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetGraphPageSchema } from "@aistudy/contracts";
import { hashSessionToken } from "@aistudy/database";
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
