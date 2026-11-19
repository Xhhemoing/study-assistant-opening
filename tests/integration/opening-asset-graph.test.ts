import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  CourseRouteActionResult,
  CourseRouteRequirementInput,
  KnowledgeSnapshot,
} from "@aistudy/contracts";
import {
  OpeningAssetGraphError,
  createExplorationRepository,
  createOpeningAssetGraphRepository,
  createOpeningBudgetRepository,
  createOpeningCourseRouteRepository,
  createOpeningCourseSharedSkillRepository,
  createOpeningEphemeralProvenanceRepository,
  createOpeningLearningAssetLinkRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningGoalRepository,
  createOpeningLearningRepository,
  createOpeningNoteRepository,
  createOpeningSourceActionsRepository,
  createOpeningTeachingContentRepository,
  createPromotionRepository,
} from "@aistudy/database";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const sourceKeys = {
  stagingKey: (id: string) => `opening/staging/${id}`,
  finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
};

let f: OpeningFixture;

beforeEach(async () => {
  f = await createOpeningFixture();
});

afterEach(async () => {
  await f?.close();
});

function assertReady(value: CourseRouteActionResult) {
  expect(value.kind).toBe("ready");
  if (value.kind !== "ready") throw new Error(JSON.stringify(value));
  return value;
}

async function readWriteFootprint() {
  return {
    jobs: await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    outbox: await f.sql`SELECT id FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    exposures: await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    observations: await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    documents: await f.sql`SELECT id, updated_at FROM library_documents WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    links: await f.sql`SELECT id, revision FROM opening_learning_asset_links WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    preferences: await f.sql`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${f.scope.workspaceId}`,
  };
}

async function insertUploadedSource(version = 1, name = "Linear Algebra.pdf") {
  const seeds = backupRows(f.sql, f.scope);
  const sourceId = await seeds.source("uploaded", version);
  await f.sql`UPDATE opening_sources SET name=${name} WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},${version},${f.scope.workspaceId},21,${"a".repeat(64)},'available')`;
  const chunkId = await seeds.chunk(sourceId, version);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  return { sourceId, chunkId };
}

it("drills down goal -> requirement -> knowledge/source/observation with zero writes/exposures and exact revisions", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'线性代数精讲',${courseId})`;
  const { sourceId, chunkId } = await insertUploadedSource(1, "线代讲义.pdf");
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;

  const kn1 = randomUUID();
  const kn2 = randomUUID();
  const snapshot: KnowledgeSnapshot = {
    courseId,
    version: 1,
    nodes: [
      { id: kn1, courseId, label: "矩阵的秩", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" },
      { id: kn2, courseId, label: "零空间维数", kind: "concept", evidenceChunkIds: [chunkId], status: "supported" },
    ],
    edges: [{ from: kn1, to: kn2, kind: "prerequisite", evidenceChunkIds: [chunkId], status: "supported" }],
  };
  await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${f.sql.json(snapshot)},${f.sql.json({ [sourceId]: 1 })})`;

  const goalsRepo = createOpeningLearningGoalRepository(f.sql);
  const createdGoal = await goalsRepo.create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [courseId],
    title: "期末满分目标",
    kind: "final-exam",
    targetDate: "2026-12-20",
    examDate: "2026-12-25",
    weeklyMinutes: 120,
    priority: 2,
    learningMode: "understand",
    successCriteria: "独立解释并完成题型",
  });
  const updatedGoal = await goalsRepo.update(f.scope, createdGoal.id, {
    expectedRevision: createdGoal.revision,
    weeklyMinutes: 180,
  });
  expect(updatedGoal.revision).toBe(2);

  const reqInput: CourseRouteRequirementInput = {
    id: randomUUID(),
    stableSkillId: randomUUID(),
    knowledgeNodeId: kn1,
    requirementKey: "la:rank-nullity",
    title: "掌握秩与零空间维数定理",
    position: 0,
    mandatory: true,
    goalIds: [updatedGoal.id],
    prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId, page: 1 }],
    verification: {
      kind: "rubric",
      status: "needs_check",
      exerciseKeys: [],
      rubric: "SECRET-RUBRIC-DO-NOT-EXPOSE",
      missingReasons: [],
    },
    origin: "confirmed",
  };
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, courseId, {
    expectedRevisions: [],
    requirements: [reqInput],
    confirmScope: true,
  });
  await f.sql`UPDATE course_requirements SET revision=2,
      verification=${f.sql.json({ ...reqInput.verification, status: "ready", exerciseKeys: ["rank-q1"] })}
    WHERE id=${reqInput.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;

  const started = assertReady(
    await route.start(f.scope, courseId, {
      goalId: updatedGoal.id,
      expectedGoalRevision: 2,
      requirementId: reqInput.id,
      expectedRequirementRevision: 2,
      clientKey: randomUUID(),
      minutes: 20,
    }),
  );

  const content = createOpeningTeachingContentRepository(f.sql);
  const promptId = randomUUID();
  const answerId = randomUUID();
  const unit = await content.createUnit(f.scope, {
    title: "秩与零空间练习",
    blocks: [
      { id: promptId, type: "prompt", content: { text: "计算 1/3 + 1/4", interaction: { kind: "numeric" } } },
      {
        id: answerId,
        type: "answer_key",
        content: {
          answer: "7/12",
          hidden: true,
          hints: { direction: "先通分", concept: "分数加法", firstStep: "找公分母 12" },
        },
      },
    ],
  });
  await content.publishActivitySpec(f.scope, {
    activityId: started.activity.id,
    teachingUnitId: unit.id,
    expectedVersion: 0,
    expectedRevisionNumber: 1,
    revisionNumber: 1,
    blockOrder: [
      { blockId: promptId, blockType: "prompt", role: "prompt", position: 0 },
      { blockId: answerId, blockType: "answer_key", role: "answer_key", position: 1 },
    ],
    sourceRefs: [{ sourceId, chunkId, version: 1 }],
  });

  const learning = createOpeningLearningRepository(f.sql);
  const session = await learning.createSession(f.scope, {
    activityId: started.activity.id,
    courseId,
    skillLabel: started.activity.learnerFocus!.skillLabel,
    sourceIds: [sourceId],
  });
  const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, {
    sessionId: session.id,
    clientKey: randomUUID(),
    teachingBlock: { blockId: promptId, contentVersion: 1 },
  });
  const obs = await learning.insertObservation(f.scope, {
    attemptId: attempt.id,
    sessionId: session.id,
    courseId,
    skillLabel: started.activity.learnerFocus!.skillLabel,
    sourceIds: [sourceId],
    problemId: attempt.problemId,
    answer: "7/12",
    outcome: "unverified",
    assistance: "independent",
    clientKey: randomUUID(),
  });
  expect(obs.eligibility).toMatchObject({
    independentAttempt: "yes",
    verifiedCorrect: "yes",
    usableForCurrentVersion: "yes",
  });

  const before = await readWriteFootprint();
  const graphRepo = createOpeningAssetGraphRepository(f.sql, {
    cursorSecret: "integration-graph-secret-1234567890",
  });

  const goalRoots = await graphRepo.query(f.scope, {
    op: "roots",
    context: { kind: "goal", id: `goal/${updatedGoal.id}` },
    lens: "structure",
    include: ["summary"],
  });
  expect(goalRoots.nodes.find(n => n.id === `requirement/${reqInput.id}`)?.summary).toEqual({
    learnerState: "independent",
    requirementStatus: "needs_verification",
  });

  const goalOut = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "goal", id: `goal/${updatedGoal.id}` },
    lens: "structure",
    focus: `goal/${updatedGoal.id}`,
    direction: "out",
  });
  expect(goalOut.edges).toEqual([
    expect.objectContaining({
      relation: "scopes",
      basis: "recorded",
      from: `goal/${updatedGoal.id}`,
      to: `requirement/${reqInput.id}`,
    }),
  ]);

  const reqSources = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "goal", id: `goal/${updatedGoal.id}` },
    lens: "assets",
    focus: `requirement/${reqInput.id}`,
    direction: "out",
  });
  expect(reqSources.edges).toEqual([
    expect.objectContaining({
      relation: "usesSource",
      from: `requirement/${reqInput.id}`,
      to: `source/${sourceId}`,
      sourceVersion: 1,
      page: 1,
    }),
  ]);

  const reqEvidence = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "goal", id: `goal/${updatedGoal.id}` },
    lens: "evidence",
    focus: `requirement/${reqInput.id}`,
    direction: "out",
  });
  expect(reqEvidence.edges).toEqual([
    expect.objectContaining({
      relation: "hasObservation",
      from: `requirement/${reqInput.id}`,
      to: `observation/${obs.id}`,
    }),
  ]);
  const obsNode = reqEvidence.nodes.find(n => n.id === `observation/${obs.id}`);
  expect(obsNode?.label).toBe("独立作答记录");

  const reqDetail = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "goal", id: `goal/${updatedGoal.id}` },
    lens: "all",
    focus: `requirement/${reqInput.id}`,
  });
  expect(reqDetail.detail?.learnerState).toBe("independent");
  expect(reqDetail.detail?.requirementStatus).toBe("needs_verification");
  expect(reqDetail.detail?.actions).toEqual([
    {
      kind: "startCourseRequirement",
      courseId,
      goalId: updatedGoal.id,
      requirementId: reqInput.id,
      expectedGoalRevision: 2,
      expectedRequirementRevision: 2,
      label: "开始学习此要求",
    },
    {
      kind: "navigate",
      href: `/opening/courses/${courseId}`,
      label: "查看课程路线",
    },
  ]);

  const serialized = JSON.stringify([goalRoots, goalOut, reqSources, reqEvidence, reqDetail]);
  expect(serialized).not.toContain("SECRET-RUBRIC-DO-NOT-EXPOSE");
  expect(serialized).not.toContain("计算 1/3 + 1/4");
  expect(serialized).not.toContain("7/12");

  expect(await readWriteFootprint()).toEqual(before);
});

it("projects promotedTo edge for no-course note <- free exploration and returns NOT_FOUND in goal context", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Course A',${courseId})`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [courseId],
    title: "课程目标",
    kind: "interest",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 60,
    priority: 1,
    learningMode: "understand",
    successCriteria: "",
  });

  const explorationRepo = createExplorationRepository(f.sql);
  const exp = await explorationRepo.createExploration({
    workspaceId: f.scope.workspaceId,
    ownerUserId: f.scope.ownerUserId,
    title: "无课程自由探索",
  });
  const promoRepo = createPromotionRepository(f.sql);
  const candidate = await promoRepo.create({
    workspaceId: f.scope.workspaceId,
    explorationId: exp.id,
    kind: "note",
    title: "自由探索沉淀笔记",
    body: "SECRET-EXPLORATION-BODY-CONTENT",
  });
  const accepted = await promoRepo.accept({
    workspaceId: f.scope.workspaceId,
    promotionId: candidate.id,
  });
  const docId = accepted.targetId!;

  const graphRepo = createOpeningAssetGraphRepository(f.sql);
  const incoming = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "workspace" },
    lens: "assets",
    focus: `document/${docId}`,
    direction: "in",
  });
  expect(incoming.edges).toEqual([
    {
      id: `recorded:promotedTo:exploration/${exp.id}:document/${docId}`,
      from: `exploration/${exp.id}`,
      to: `document/${docId}`,
      relation: "promotedTo",
      basis: "recorded",
    },
  ]);
  expect(JSON.stringify(incoming)).not.toContain("SECRET-EXPLORATION-BODY-CONTENT");

  const expDetail = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "workspace" },
    lens: "assets",
    focus: `exploration/${exp.id}`,
  });
  expect(expDetail.detail?.actions).toEqual([]);

  await expect(
    graphRepo.query(f.scope, {
      op: "detail",
      context: { kind: "goal", id: `goal/${goal.id}` },
      lens: "assets",
      focus: `document/${docId}`,
    }),
  ).rejects.toSatisfy(
    err => err instanceof OpeningAssetGraphError && err.code === "NOT_FOUND" && err.message === "请求的资源不可用。",
  );

  await expect(
    graphRepo.query(f.otherScope, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `document/${docId}`,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", message: "请求的资源不可用。" });
});

it("does not leak another goal's requirement sharing the same source inside goal context", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Shared Source Course',${courseId})`;
  const { sourceId, chunkId } = await insertUploadedSource(1, "公共资料.pdf");
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;

  const goalsRepo = createOpeningLearningGoalRepository(f.sql);
  const g1 = await goalsRepo.create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [courseId],
    title: "目标一",
    kind: "custom",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 60,
    priority: 1,
    learningMode: "understand",
    successCriteria: "",
  });
  const g2 = await goalsRepo.create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [courseId],
    title: "目标二",
    kind: "custom",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 60,
    priority: 1,
    learningMode: "exam",
    successCriteria: "",
  });

  const req1Id = randomUUID();
  const req2Id = randomUUID();
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, courseId, {
    expectedRevisions: [],
    confirmScope: true,
    requirements: [
      {
        id: req1Id,
        stableSkillId: randomUUID(),
        knowledgeNodeId: null,
        requirementKey: "req:g1",
        title: "目标一要求",
        position: 0,
        mandatory: true,
        goalIds: [g1.id],
        prerequisiteIds: [],
        sourceRefs: [{ sourceId, sourceVersion: 1, chunkId, page: 1 }],
        verification: { kind: "manual", status: "ready", exerciseKeys: [], rubric: "说明", missingReasons: [] },
        origin: "confirmed",
      },
      {
        id: req2Id,
        stableSkillId: randomUUID(),
        knowledgeNodeId: null,
        requirementKey: "req:g2",
        title: "目标二要求",
        position: 1,
        mandatory: true,
        goalIds: [g2.id],
        prerequisiteIds: [],
        sourceRefs: [{ sourceId, sourceVersion: 1, chunkId, page: 1 }],
        verification: { kind: "manual", status: "ready", exerciseKeys: [], rubric: "说明", missingReasons: [] },
        origin: "confirmed",
      },
    ],
  });

  const graphRepo = createOpeningAssetGraphRepository(f.sql);
  const g1SourceIn = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "goal", id: `goal/${g1.id}` },
    lens: "assets",
    focus: `source/${sourceId}`,
    direction: "in",
  });
  expect(g1SourceIn.edges.map(e => e.from)).toEqual([`requirement/${req1Id}`]);

  await expect(
    graphRepo.query(f.scope, {
      op: "detail",
      context: { kind: "goal", id: `goal/${g1.id}` },
      lens: "all",
      focus: `requirement/${req2Id}`,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("hides permanently deleted sources, their derived notes/observations, while keeping AI-excluded sources browsable", async () => {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Privacy Course',${courseId})`;
  const aiSource = await insertUploadedSource(1, "仅排除AI资料.pdf");
  const delSource = await insertUploadedSource(1, "永久删除资料.pdf");
  const mAi = randomUUID();
  const mDel = randomUUID();
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES
      (${mAi},${f.scope.workspaceId},${courseId},'source',${aiSource.sourceId},'core','course'),
      (${mDel},${f.scope.workspaceId},${courseId},'source',${delSource.sourceId},'core','course')`;

  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [courseId],
    title: "隐私测试目标",
    kind: "interest",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 60,
    priority: 1,
    learningMode: "understand",
    successCriteria: "",
  });

  const reqId = randomUUID();
  await createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true }).confirm(f.scope, courseId, {
    expectedRevisions: [],
    confirmScope: true,
    requirements: [
      {
        id: reqId,
        stableSkillId: randomUUID(),
        knowledgeNodeId: null,
        requirementKey: "req:privacy",
        title: "隐私边界要求",
        position: 0,
        mandatory: true,
        goalIds: [goal.id],
        prerequisiteIds: [],
        sourceRefs: [
          { sourceId: aiSource.sourceId, sourceVersion: 1, chunkId: aiSource.chunkId, page: 1 },
          { sourceId: delSource.sourceId, sourceVersion: 1, chunkId: delSource.chunkId, page: 1 },
        ],
        verification: { kind: "manual", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] },
        origin: "confirmed",
      },
    ],
  });

  // Create linked notes for both sources via snippet provenance + asset links
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const ephem = createOpeningEphemeralProvenanceRepository(f.sql);
  const notesRepo = createOpeningNoteRepository(f.sql);
  const linksRepo = createOpeningLearningAssetLinkRepository(f.sql);

  const saveLinkedNote = async (sourceId: string, title: string) => {
    const reqKey = `note-req:${randomUUID()}`;
    const resv = await budget.reserve(f.scope, { purpose: "tutor", amountCents: 1, requestId: reqKey });
    const [ws] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
    await ephem.record(f.scope, {
      requestId: reqKey,
      privacyEpoch: Number(ws!.privacy_epoch),
      contextSourceRefs: [{ sourceId, sourceVersion: 1 }],
    });
    const saved = await notesRepo.saveSnippet(f.scope, {
      title,
      text: `PRIVATE-BODY-${title}`,
      provenanceId: resv.id,
    });
    await linksRepo.create(f.scope, {
      clientKey: randomUUID(),
      assetType: "document",
      assetId: saved.documentId,
      assetVersion: null,
      courseId,
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      requirementId: reqId,
      expectedRequirementRevision: 1,
      purpose: "reference",
      origin: null,
    });
    return saved.documentId;
  };

  const aiDocId = await saveLinkedNote(aiSource.sourceId, "AI排除材料关联笔记");
  const delDocId = await saveLinkedNote(delSource.sourceId, "永久删除材料关联笔记");

  // Also create observations referencing aiSource and delSource
  const learning = createOpeningLearningRepository(f.sql);
  const actId = randomUUID();
  await f.sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,source_ids,status,intent_kind,intent_summary,client_key,create_intent)
    VALUES(${actId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${[aiSource.sourceId, delSource.sourceId]}::uuid[],'active','topic','Privacy obs',${randomUUID()},'{}'::jsonb)`;
  const session = await learning.createSession(f.scope, {
    activityId: actId,
    courseId,
    skillLabel: "隐私边界要求",
    sourceIds: [aiSource.sourceId, delSource.sourceId],
  });
  const obsAi = await learning.insertObservation(f.scope, {
    sessionId: session.id,
    courseId,
    skillLabel: "隐私边界要求",
    sourceIds: [aiSource.sourceId],
    answer: "ai-excluded-answer",
    outcome: "correct",
    assistance: "independent",
    clientKey: randomUUID(),
  });
  const obsDel = await learning.insertObservation(f.scope, {
    sessionId: session.id,
    courseId,
    skillLabel: "隐私边界要求",
    sourceIds: [delSource.sourceId],
    answer: "deleted-source-answer",
    outcome: "correct",
    assistance: "independent",
    clientKey: randomUUID(),
  });

  // Ensure cursors before privacy changes become CURSOR_STALE after privacyEpoch bump.
  const graphRepo = createOpeningAssetGraphRepository(f.sql, { cursorSecret: "privacy-test-secret" });
  const prePage = await graphRepo.query(f.scope, {
    op: "roots",
    context: { kind: "workspace" },
    lens: "all",
    limit: 1,
  });
  expect(prePage.page.nextCursor).toBeTruthy();

  const sourceActions = createOpeningSourceActionsRepository(f.sql);
  await sourceActions.apply(
    f.scope,
    aiSource.sourceId,
    { action: "exclude", expectedVersion: 1, expectedMembershipIds: [mAi] },
    sourceKeys,
    new Date(),
  );
  await sourceActions.apply(
    f.scope,
    delSource.sourceId,
    { action: "delete", expectedVersion: 1, expectedMembershipIds: [mDel] },
    sourceKeys,
    new Date(),
  );

  await expect(
    graphRepo.query(f.scope, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
      cursor: prePage.page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CURSOR_STALE" });

  // Permanently deleted source, its note, and its observation are all NOT_FOUND and absent from graph
  for (const hiddenId of [
    `source/${delSource.sourceId}`,
    `document/${delDocId}`,
    `observation/${obsDel.id}`,
    `observation/${obsAi.id}`,
  ]) {
    await expect(
      graphRepo.query(f.scope, {
        op: "detail",
        context: { kind: "workspace" },
        lens: "all",
        focus: hiddenId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }

  // AI-excluded source & its personal note remain visible to the owner
  const aiSourceDetail = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "goal", id: `goal/${goal.id}` },
    lens: "assets",
    focus: `source/${aiSource.sourceId}`,
  });
  expect(aiSourceDetail.nodes[0]?.id).toBe(`source/${aiSource.sourceId}`);

  const aiDocDetail = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "goal", id: `goal/${goal.id}` },
    lens: "assets",
    focus: `document/${aiDocId}`,
  });
  expect(aiDocDetail.nodes[0]?.id).toBe(`document/${aiDocId}`);

  // Neither deleted nor privacy-excluded observation appears in requirement evidence neighbors.
  const evidenceOut = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "goal", id: `goal/${goal.id}` },
    lens: "evidence",
    focus: `requirement/${reqId}`,
    direction: "out",
  });
  expect(evidenceOut.edges).toEqual([]);

  // Archiving the owning course hides the course, goal, and requirement as NOT_FOUND.
  await f.sql`UPDATE courses SET archived_at = now() WHERE id = ${courseId}`;
  await expect(
    graphRepo.query(f.scope, {
      op: "roots",
      context: { kind: "course", id: `course/${courseId}` },
      lens: "all",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    graphRepo.query(f.scope, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "structure",
      focus: `requirement/${reqId}`,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("projects cross-course shared-skills evidence with attribution, keeps homonymous knowledge separate, and invalidates on unlink/revision/exclusion", async () => {
  const course1Id = randomUUID();
  const course2Id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
    (${course1Id},${f.scope.workspaceId},'线性代数基础',${course1Id}),
    (${course2Id},${f.scope.workspaceId},'高等矩阵应用',${course2Id})`;

  const src1 = await insertUploadedSource(1, "线代讲义.pdf");
  const src2 = await insertUploadedSource(1, "矩阵应用讲义.pdf");
  const m1 = randomUUID();
  const m2 = randomUUID();
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES
    (${m1},${f.scope.workspaceId},${course1Id},'source',${src1.sourceId},'core','course'),
    (${m2},${f.scope.workspaceId},${course2Id},'source',${src2.sourceId},'core','course')`;

  const sharedKnId = randomUUID();
  const snapshot1: KnowledgeSnapshot = {
    courseId: course1Id,
    version: 1,
    nodes: [{ id: sharedKnId, courseId: course1Id, label: "矩阵的秩", kind: "concept", evidenceChunkIds: [src1.chunkId], status: "supported" }],
    edges: [],
  };
  const snapshot2: KnowledgeSnapshot = {
    courseId: course2Id,
    version: 1,
    nodes: [{ id: sharedKnId, courseId: course2Id, label: "矩阵的秩", kind: "concept", evidenceChunkIds: [src2.chunkId], status: "supported" }],
    edges: [],
  };
  await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions) VALUES
    (${f.scope.workspaceId},${f.scope.ownerUserId},${course1Id},1,${f.sql.json(snapshot1)},${f.sql.json({ [src1.sourceId]: 1 })}),
    (${f.scope.workspaceId},${f.scope.ownerUserId},${course2Id},1,${f.sql.json(snapshot2)},${f.sql.json({ [src2.sourceId]: 1 })})`;

  const goalsRepo = createOpeningLearningGoalRepository(f.sql);
  const goal1 = await goalsRepo.create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [course1Id],
    title: "基础线代目标",
    kind: "interest",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 90,
    priority: 1,
    learningMode: "understand",
    successCriteria: "",
  });
  const goal2 = await goalsRepo.create(f.scope, {
    clientKey: randomUUID(),
    courseIds: [course2Id],
    title: "矩阵迁移目标",
    kind: "interest",
    targetDate: null,
    examDate: null,
    weeklyMinutes: 90,
    priority: 1,
    learningMode: "understand",
    successCriteria: "",
  });

  const skillId = randomUUID();
  const sharedRubric = "正确运用分数通分并说明计算依据。";
  const sharedConditions = { responseFormat: "numeric" as const, timeLimitSeconds: null, assistance: "independent" as const };
  const sourceReqId = randomUUID();
  const targetReqId = randomUUID();

  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, course1Id, {
    expectedRevisions: [],
    confirmScope: true,
    requirements: [
      {
        id: sourceReqId,
        stableSkillId: skillId,
        knowledgeNodeId: sharedKnId,
        requirementKey: "la:fraction-add",
        title: "独立完成基础分数通分",
        position: 0,
        mandatory: true,
        goalIds: [goal1.id],
        prerequisiteIds: [],
        sourceRefs: [{ sourceId: src1.sourceId, sourceVersion: 1, chunkId: src1.chunkId, page: 1 }],
        evidenceConditions: sharedConditions,
        verification: { kind: "rubric", status: "ready", exerciseKeys: ["q-base"], rubric: sharedRubric, missingReasons: [] },
        origin: "confirmed",
      },
    ],
  });
  await route.confirm(f.scope, course2Id, {
    expectedRevisions: [],
    confirmScope: true,
    requirements: [
      {
        id: targetReqId,
        stableSkillId: randomUUID(),
        knowledgeNodeId: sharedKnId,
        requirementKey: "app:fraction-transfer",
        title: "矩阵变换中的通分迁移",
        position: 0,
        mandatory: true,
        goalIds: [goal2.id],
        prerequisiteIds: [],
        sourceRefs: [{ sourceId: src2.sourceId, sourceVersion: 1, chunkId: src2.chunkId, page: 1 }],
        evidenceConditions: sharedConditions,
        verification: { kind: "rubric", status: "ready", exerciseKeys: ["q-app"], rubric: sharedRubric, missingReasons: [] },
        origin: "confirmed",
      },
    ],
  });
  await f.sql`UPDATE course_requirements
    SET verification=${f.sql.json({ kind: "rubric", status: "ready", exerciseKeys: ["q-ready"], rubric: sharedRubric, missingReasons: [] })}
    WHERE id IN (${sourceReqId}, ${targetReqId})
      AND workspace_id=${f.scope.workspaceId}
      AND owner_user_id=${f.scope.ownerUserId}`;

  const started = assertReady(
    await route.start(f.scope, course1Id, {
      goalId: goal1.id,
      expectedGoalRevision: 1,
      requirementId: sourceReqId,
      expectedRequirementRevision: 1,
      clientKey: randomUUID(),
      minutes: 20,
    }),
  );

  const content = createOpeningTeachingContentRepository(f.sql);
  const p1Id = randomUUID();
  const a1Id = randomUUID();
  const p2Id = randomUUID();
  const a2Id = randomUUID();
  const unit = await content.createUnit(f.scope, {
    title: "分数通分双题独立验证",
    blocks: [
      { id: p1Id, type: "prompt", content: { text: "计算 1/3 + 1/4", interaction: { kind: "numeric" } } },
      { id: a1Id, type: "answer_key", content: { answer: "7/12", hidden: true } },
      { id: p2Id, type: "prompt", content: { text: "计算 1/2 + 1/3", interaction: { kind: "numeric" } } },
      { id: a2Id, type: "answer_key", content: { answer: "5/6", hidden: true } },
    ],
  });
  await content.publishActivitySpec(f.scope, {
    activityId: started.activity.id,
    teachingUnitId: unit.id,
    expectedVersion: 0,
    expectedRevisionNumber: 1,
    revisionNumber: 1,
    blockOrder: [
      { blockId: p1Id, blockType: "prompt", role: "prompt", position: 0 },
      { blockId: a1Id, blockType: "answer_key", role: "answer_key", position: 1 },
      { blockId: p2Id, blockType: "prompt", role: "prompt", position: 2 },
      { blockId: a2Id, blockType: "answer_key", role: "answer_key", position: 3 },
    ],
    sourceRefs: [{ sourceId: src1.sourceId, chunkId: src1.chunkId, version: 1 }],
  });

  const learning = createOpeningLearningRepository(f.sql);
  const attempts = createOpeningLearningAttemptRepository(f.sql);
  const session = await learning.createSession(f.scope, {
    activityId: started.activity.id,
    courseId: course1Id,
    skillLabel: started.activity.learnerFocus!.skillLabel,
    sourceIds: [src1.sourceId],
  });
  const att1 = await attempts.create(f.scope, {
    sessionId: session.id,
    clientKey: randomUUID(),
    teachingBlock: { blockId: p1Id, contentVersion: 1 },
  });
  const obs1 = await learning.insertObservation(f.scope, {
    attemptId: att1.id,
    sessionId: session.id,
    courseId: course1Id,
    skillLabel: started.activity.learnerFocus!.skillLabel,
    sourceIds: [src1.sourceId],
    problemId: att1.problemId,
    answer: "7/12",
    outcome: "unverified",
    assistance: "independent",
    clientKey: randomUUID(),
  });
  const att2 = await attempts.create(f.scope, {
    sessionId: session.id,
    clientKey: randomUUID(),
    teachingBlock: { blockId: p2Id, contentVersion: 1 },
  });
  const obs2 = await learning.insertObservation(f.scope, {
    attemptId: att2.id,
    sessionId: session.id,
    courseId: course1Id,
    skillLabel: started.activity.learnerFocus!.skillLabel,
    sourceIds: [src1.sourceId],
    problemId: att2.problemId,
    answer: "5/6",
    outcome: "unverified",
    assistance: "independent",
    clientKey: randomUUID(),
  });

  const sharedRepo = createOpeningCourseSharedSkillRepository(f.sql);
  const linked = await sharedRepo.command(f.scope, course2Id, {
    action: "link",
    sourceRequirementId: sourceReqId,
    expectedSourceRevision: 1,
    targetRequirementId: targetReqId,
    expectedTargetRevision: 1,
    expectedLinkRevision: 0,
    confirmed: true,
  });
  const linkId = linked.links[0]!.id;

  const before = await readWriteFootprint();
  const graphRepo = createOpeningAssetGraphRepository(f.sql, {
    cursorSecret: "integration-shared-skills-secret-1234",
  });

  // 1. Course context (course2): summary verified/independent without missing-evidence warning.
  const c2Roots = await graphRepo.query(f.scope, {
    op: "roots",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    include: ["summary"],
  });
  expect(c2Roots.warnings).toEqual([]);
  expect(c2Roots.nodes.find(n => n.id === `requirement/${targetReqId}`)?.summary).toEqual({
    learnerState: "independent",
    requirementStatus: "verified",
  });

  // 2. Course context neighbors with pagination returns derived:hasObservation + sharedAttribution.
  const page1 = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    focus: `requirement/${targetReqId}`,
    direction: "out",
    limit: 1,
  });
  expect(page1.edges).toHaveLength(1);
  expect(page1.page.nextCursor).toBeTruthy();
  const page2 = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    focus: `requirement/${targetReqId}`,
    direction: "out",
    limit: 1,
    cursor: page1.page.nextCursor!,
  });
  expect(page2.edges).toHaveLength(1);
  expect(page2.page.nextCursor).toBeNull();

  const allSharedEdges = [...page1.edges, ...page2.edges];
  expect(allSharedEdges.map(e => e.to).sort()).toEqual(
    [`observation/${obs1.id}`, `observation/${obs2.id}`].sort(),
  );
  for (const edge of allSharedEdges) {
    expect(edge).toMatchObject({
      basis: "derived",
      relation: "hasObservation",
      sharedAttribution: {
        linkId,
        linkRevision: 1,
        stableSkillId: skillId,
        sourceCourseId: course1Id,
        sourceCourseTitle: "线性代数基础",
        sourceRequirementId: sourceReqId,
        sourceRequirementTitle: "独立完成基础分数通分",
        sourceRequirementRevision: 1,
        targetRequirementRevision: 2,
        effective: true,
      },
    });
  }

  // 3. Observation detail & neighbors in course2 + goal2 + workspace contexts.
  const obsDetailInC2 = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    focus: `observation/${obs1.id}`,
  });
  expect(obsDetailInC2.detail?.actions).toEqual([
    { kind: "navigate", href: `/opening/courses/${course1Id}`, label: "查看来源课程" },
  ]);
  expect(obsDetailInC2.detail?.notes.some(n => n.includes("线性代数基础"))).toBe(true);

  const reqDetailInGoal2 = await graphRepo.query(f.scope, {
    op: "detail",
    context: { kind: "goal", id: `goal/${goal2.id}` },
    lens: "all",
    focus: `requirement/${targetReqId}`,
  });
  expect(reqDetailInGoal2.detail?.learnerState).toBe("independent");
  expect(reqDetailInGoal2.detail?.requirementStatus).toBe("verified");
  expect(
    reqDetailInGoal2.detail?.notes.some(
      n =>
        n.includes("跨课共享有效证据") &&
        n.includes("线性代数基础") &&
        n.includes("独立完成基础分数通分") &&
        n.includes("第 1 版"),
    ),
  ).toBe(true);

  const wsObsIn = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "workspace" },
    lens: "evidence",
    focus: `observation/${obs1.id}`,
    direction: "in",
  });
  expect(wsObsIn.edges.map(e => e.basis).sort()).toEqual(["derived", "recorded"]);

  // Homonymous knowledge nodes stay strictly separate per course.
  const wsKnowledge = await graphRepo.query(f.scope, {
    op: "roots",
    context: { kind: "workspace" },
    lens: "structure",
    kinds: ["knowledge"],
  });
  expect(wsKnowledge.nodes.map(n => n.id)).toEqual(
    expect.arrayContaining([
      `knowledge/${course1Id}/${sharedKnId}`,
      `knowledge/${course2Id}/${sharedKnId}`,
    ]),
  );

  // Zero writes from asset-graph queries.
  expect(await readWriteFootprint()).toEqual(before);

  // 4. Unlink -> CURSOR_STALE & hides shared observation/edges in course2.
  const cursorBeforeUnlink = page1.page.nextCursor!;
  await sharedRepo.command(f.scope, course2Id, {
    action: "unlink",
    linkId,
    expectedRevision: 1,
  });
  await expect(
    graphRepo.query(f.scope, {
      op: "neighbors",
      context: { kind: "course", id: `course/${course2Id}` },
      lens: "evidence",
      focus: `requirement/${targetReqId}`,
      direction: "out",
      limit: 1,
      cursor: cursorBeforeUnlink,
    }),
  ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  await expect(
    graphRepo.query(f.scope, {
      op: "detail",
      context: { kind: "course", id: `course/${course2Id}` },
      lens: "evidence",
      focus: `observation/${obs1.id}`,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  // 5. Re-link, then bump source requirement revision -> CURSOR_STALE & hides shared evidence.
  await sharedRepo.command(f.scope, course2Id, {
    action: "link",
    sourceRequirementId: sourceReqId,
    expectedSourceRevision: 1,
    targetRequirementId: targetReqId,
    expectedTargetRevision: 2,
    expectedLinkRevision: 2,
    confirmed: true,
  });
  const pageBeforeRevBump = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    focus: `requirement/${targetReqId}`,
    direction: "out",
    limit: 1,
  });
  expect(pageBeforeRevBump.page.nextCursor).toBeTruthy();

  await f.sql`UPDATE course_requirements SET revision = 2, updated_at = now()
    WHERE id = ${sourceReqId} AND workspace_id = ${f.scope.workspaceId} AND owner_user_id = ${f.scope.ownerUserId}`;
  await expect(
    graphRepo.query(f.scope, {
      op: "neighbors",
      context: { kind: "course", id: `course/${course2Id}` },
      lens: "evidence",
      focus: `requirement/${targetReqId}`,
      direction: "out",
      limit: 1,
      cursor: pageBeforeRevBump.page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  expect(
    (
      await graphRepo.query(f.scope, {
        op: "neighbors",
        context: { kind: "course", id: `course/${course2Id}` },
        lens: "evidence",
        focus: `requirement/${targetReqId}`,
        direction: "out",
      })
    ).edges,
  ).toEqual([]);

  // 6. Restore source revision and verify privacy-excluding source1 -> CURSOR_STALE & hides shared evidence.
  await f.sql`UPDATE course_requirements SET revision = 1, updated_at = now()
    WHERE id = ${sourceReqId} AND workspace_id = ${f.scope.workspaceId} AND owner_user_id = ${f.scope.ownerUserId}`;
  const pageBeforeExclude = await graphRepo.query(f.scope, {
    op: "neighbors",
    context: { kind: "course", id: `course/${course2Id}` },
    lens: "evidence",
    focus: `requirement/${targetReqId}`,
    direction: "out",
    limit: 1,
  });
  expect(pageBeforeExclude.page.nextCursor).toBeTruthy();

  await createOpeningSourceActionsRepository(f.sql).apply(
    f.scope,
    src1.sourceId,
    { action: "exclude", expectedVersion: 1, expectedMembershipIds: [m1] },
    sourceKeys,
    new Date(),
  );
  await expect(
    graphRepo.query(f.scope, {
      op: "neighbors",
      context: { kind: "course", id: `course/${course2Id}` },
      lens: "evidence",
      focus: `requirement/${targetReqId}`,
      direction: "out",
      limit: 1,
      cursor: pageBeforeExclude.page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  expect(
    (
      await graphRepo.query(f.scope, {
        op: "neighbors",
        context: { kind: "course", id: `course/${course2Id}` },
        lens: "evidence",
        focus: `requirement/${targetReqId}`,
        direction: "out",
      })
    ).edges,
  ).toEqual([]);
  await expect(
    graphRepo.query(f.scope, {
      op: "detail",
      context: { kind: "course", id: `course/${course2Id}` },
      lens: "evidence",
      focus: `observation/${obs1.id}`,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
