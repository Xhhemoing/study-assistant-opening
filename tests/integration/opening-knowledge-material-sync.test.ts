import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCourseMembershipRepository,
  createOpeningJobRepository,
  createOpeningKnowledgeRepository,
  createOpeningSourceChunksRepository,
  knowledgeChunkDigests,
  type OpeningStorage,
} from "@aistudy/database";
import {
  addMembershipForPrincipal,
  createAuthRuntime,
  removeMembershipForPrincipal,
  updateMembershipPurposeForPrincipal,
  type AuthRuntime,
} from "../../apps/web/src/features/auth/service";
import { createOpeningKnowledgeService } from "../../apps/web/src/features/opening/knowledge/service";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createBuildCourseKnowledgeHandler } from "../../apps/worker/src/jobs/build-course-knowledge";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
let runtime: AuthRuntime;

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
});

afterAll(async () => {
  await runtime?.close();
  if (f) {
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId}, ${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM users WHERE id IN (${f.scope.ownerUserId}, ${f.otherScope.ownerUserId})`;
    await f.close();
  }
});

beforeEach(async () => {
  await f.sql`DELETE FROM opening_outbox WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_jobs WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_knowledge_confirmations WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_course_knowledge WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM course_asset_memberships WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM courses WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_source_versions WHERE workspace_id = ${f.scope.workspaceId}`;
  await f.sql`DELETE FROM opening_sources WHERE workspace_id = ${f.scope.workspaceId}`;
});

function principal() {
  return {
    userId: f.scope.ownerUserId,
    workspaceId: f.scope.workspaceId,
    sessionId: "sync-integration-session",
  };
}

async function seedSource(options: {
  name?: string;
  version?: number;
  uploadState?: "pending" | "uploaded";
  parseState?: "not_started" | "queued" | "running" | "ready" | "failed";
  text?: string;
  skipChunk?: boolean;
  imageObjectKey?: string | null;
} = {}) {
  const id = randomUUID();
  const version = options.version ?? 1;
  const uploadState = options.uploadState ?? "uploaded";
  const parseState = options.parseState ?? "ready";
  const text = options.text ?? `材料内容 ${id}`;
  const bytes = Buffer.from(text || "binary-scan", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  await f.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${id}, ${f.scope.workspaceId}, ${options.name ?? "lecture.txt"}, 'text/plain', ${bytes.length}, ${sha256}, ${version}, ${uploadState}, ${parseState})`;

  let chunkId: string | null = null;
  if (uploadState === "uploaded") {
    await f.sql`
      INSERT INTO opening_source_versions (source_id, version, workspace_id, bytes, sha256, availability)
      VALUES (${id}, ${version}, ${f.scope.workspaceId}, ${bytes.length}, ${sha256}, 'available')`;
  }
  if (uploadState === "uploaded" && parseState === "ready" && !options.skipChunk) {
    chunkId = randomUUID();
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${chunkId}, ${id}, ${version}, 1, ${text}, ${options.imageObjectKey ?? null})`;
  }

  return { sourceId: id, chunkId, version };
}

async function seedCourse(title = "Sync Course") {
  const courseId = randomUUID();
  await f.sql`
    INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${f.scope.workspaceId}, ${title}, ${courseId})`;
  return courseId;
}

function makeBuildHandler(options?: {
  onExtract?: (chunks: Array<{ id: string; sourceId: string; text: string }>) => Promise<void>;
  nodeStatus?: "needs_check" | "supported";
}) {
  const knowledge = createOpeningKnowledgeRepository(f.sql);
  return createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (scope, courseId) => knowledge.listAuthorizedChunks(scope, courseId),
    listReferencedNodeIds: (scope, courseId) => knowledge.listReferencedNodeIds(scope, courseId),
    get: (scope, courseId) => knowledge.getForRebuild(scope, courseId),
    replace: (scope, courseId, input) => knowledge.replace(scope, courseId, input),
    onBuildCompleted: async (scope, courseId, coveredSourceVersions) => {
      await knowledge.reconcileCourseMaterials(scope, courseId, { coveredSourceVersions });
    },
    extractGraph: async (chunks) => {
      await options?.onExtract?.(chunks);
      return {
        nodes: chunks.map((c) => ({
          label: `概念-${c.sourceId}`,
          kind: "concept" as const,
          evidenceChunkIds: [c.id],
          status: options?.nodeStatus ?? "needs_check",
        })),
        edges: [],
      };
    },
  });
}

describe("opening knowledge material lifecycle sync (real PG)", () => {
  it.each(["practice", "reference", "mock_exam"] as const)("redacts zero-node coverage when a source becomes %s", async purpose => {
    const courseId = await seedCourse();
    const material = await seedSource();
    const [membership] = await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
      VALUES(${f.scope.workspaceId},${courseId},'source',${material.sourceId},'core','course','teaching') RETURNING id`;
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const saved = await knowledge.replace(f.scope, courseId, {
      expectedVersion: 0, sourceVersions: {}, extractedSourceVersions: { [material.sourceId]: material.version },
      extractedChunkDigests: knowledgeChunkDigests(await knowledge.listAuthorizedChunks(f.scope, courseId)),
      snapshot: { courseId, version: 0, nodes: [], edges: [] },
    });
    await f.sql`UPDATE course_asset_memberships SET purpose=${purpose} WHERE id=${membership!.id}`;
    const empty = { courseId, version: saved.version, nodes: [], edges: [] };
    await expect(knowledge.get(f.scope, courseId)).resolves.toMatchObject({ snapshot: empty, sourceVersions: {} });
    expect((await knowledge.get(f.scope, courseId))?.snapshot).toEqual(empty);
    const synced = await knowledge.getWithSync(f.scope, courseId);
    expect(synced.snapshot).toEqual(empty);
    expect(synced.sync?.coveredSourceVersions).toEqual({});
    expect(synced.sourceVersions).toEqual({});
    expect(await knowledge.getForRebuild(f.scope, courseId)).toEqual({
      version: saved.version, snapshot: empty, sourceVersions: {}, nodeDefinitions: {},
    });
  });

  it("rejects in-flight zero-node coverage and invalidates committed coverage when a parser replaces readable chunks at the same version", async () => {
    const courseId = await seedCourse();
    const material = await seedSource({ text: "Original cover page" });
    await createCourseMembershipRepository(f.sql).addAssetMembership({ workspaceId: f.scope.workspaceId, courseId,
      assetType: "source", assetId: material.sourceId, role: "core", visibility: "course", purpose: "teaching" });
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const parser = createOpeningSourceChunksRepository(f.sql);
    const parse = (text: string, extra?: string) => parser.replaceChunks(f.scope, {
      sourceId: material.sourceId, sourceVersion: material.version,
      chunks: [{ page: 1, text }, ...(extra ? [{ page: 2, text: extra }] : [])],
    });
    const build = (onExtract?: () => Promise<void>) => createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: knowledge.listAuthorizedChunks,
      get: knowledge.getForRebuild.bind(knowledge),
      replace: knowledge.replace,
      extractGraph: async () => {
        await onExtract?.();
        return { nodes: [], edges: [] };
      },
    });
    const job = { ...f.scope } as Parameters<ReturnType<typeof build>>[0];
    await expect(build(() => parse("Replacement cover page"))(job, { courseId }))
      .rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
    await expect(knowledge.get(f.scope, courseId)).resolves.toBeNull();
    await build()(job, { courseId });
    await parse("Replacement cover page");
    await expect(knowledge.getWithSync(f.scope, courseId)).resolves.toMatchObject({ sync: { status: "up_to_date" } });
    await parse("Replacement cover page", "New readable page");
    const stale = { sync: { status: "needs_rebuild", eligibleSourceVersions: { [material.sourceId]: material.version } } };
    await expect(knowledge.getWithSync(f.scope, courseId)).resolves.toMatchObject(stale);
    await expect(knowledge.reconcileCourseMaterials(f.scope, courseId)).resolves.toMatchObject({ enqueued: { created: true } });
  });

  it("persists a zero-node build and distinguishes readable material from ready-but-empty and failed material without a job receipt", async () => {
    const courseId = await seedCourse();
    const readable = await seedSource({ text: "Cover page and acknowledgements" });
    const blank = await seedSource({ text: " \t\n" });
    const failed = await seedSource({ parseState: "failed" });
    const membership = createCourseMembershipRepository(f.sql);
    for (const material of [readable, blank, failed]) {
      await membership.addAssetMembership({ workspaceId: f.scope.workspaceId, courseId, assetType: "source",
        assetId: material.sourceId, role: "core", visibility: "course", purpose: "teaching" });
    }
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const covered = { [readable.sourceId]: readable.version };
    const input = { expectedVersion: 0, sourceVersions: {}, snapshot: { courseId, version: 0, nodes: [], edges: [] } };
    await expect(knowledge.replace(f.scope, courseId, {
      ...input, extractedSourceVersions: { ...covered, [blank.sourceId]: blank.version },
    })).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
    const saved = await knowledge.replace(f.scope, courseId, {
      ...input, extractedSourceVersions: covered,
      extractedChunkDigests: knowledgeChunkDigests(await knowledge.listAuthorizedChunks(f.scope, courseId)),
    });
    const [stored] = await f.sql`SELECT snapshot,source_versions FROM opening_course_knowledge WHERE course_id=${courseId}`;
    expect(stored).toMatchObject({ snapshot: { version: 1, nodes: [], coveredSourceVersions: covered }, source_versions: {} });
    await expect(knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true })).resolves.toMatchObject({
      status: "up_to_date", lastBuiltVersion: null, coveredSourceVersions: covered, eligibleSourceVersions: covered, unreadableSourceCount: 2,
    });
    await expect(knowledge.replace(f.scope, courseId, { ...input, expectedVersion: saved.version })).resolves.toMatchObject({
      snapshot: { version: 2, coveredSourceVersions: covered },
    });
  });

  it("handles V2 running + V3 arriving + confirmNode CAS race and converges to up_to_date", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const service = createOpeningKnowledgeService(f.sql);

    const courseId = await seedCourse("Concurrency Course");
    const s1 = await seedSource({ name: "s1.txt", version: 1, text: "第一章 向量空间" });
    await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId,
      courseId,
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    // V1 build
    const r1 = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(r1.enqueued?.created).toBe(true);
    expect(await runJob(jobs, r1.enqueued!.jobId, makeBuildHandler({ nodeStatus: "needs_check" }))).toBe(true);

    const afterV1 = await service.get(f.scope, courseId);
    expect(afterV1.version).toBe(1);
    expect(afterV1.sync).toEqual({
      status: "up_to_date",
      activeJobId: null,
      lastBuiltVersion: 1,
      coveredSourceVersions: { [s1.sourceId]: 1 },
      eligibleSourceVersions: { [s1.sourceId]: 1 },
      parsingSourceCount: 0,
    });
    const node1 = afterV1.snapshot.nodes[0]!;

    // Start V2 and pause inside extractGraph AFTER chunks for S1 were read.
    const v2Job = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "manual-v2-run" });
    expect(v2Job.created).toBe(true);

    let enteredExtract!: () => void;
    let releaseExtract!: () => void;
    const extractEntered = new Promise<void>((resolve) => {
      enteredExtract = resolve;
    });
    const extractProceed = new Promise<void>((resolve) => {
      releaseExtract = resolve;
    });

    const v2Promise = runJob(
      jobs,
      v2Job.jobId,
      makeBuildHandler({
        nodeStatus: "needs_check",
        onExtract: async () => {
          enteredExtract();
          await extractProceed;
        },
      }),
    );

    await extractEntered;

    // While V2 is running: S2 arrives & becomes ready -> coalesced V3 queued; burst coalesces to same job.
    const s2 = await seedSource({ name: "s2.txt", version: 1, text: "第二章 线性变换" });
    await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId,
      courseId,
      assetType: "source",
      assetId: s2.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    const onReady = await knowledge.reconcileCoursesForSource(f.scope, { sourceId: s2.sourceId });
    expect(onReady.courseIds).toEqual([courseId]);
    const v3JobId = onReady.results[0]!.enqueued!.jobId;
    expect(onReady.results[0]!.enqueued!.created).toBe(true);
    expect(v3JobId).not.toBe(v2Job.jobId);

    const burst = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(burst.enqueued).toEqual({
      jobId: v3JobId,
      kind: "build-course-knowledge",
      created: false,
    });

    // Concurrently confirm N1 while V2 is running -> bumps graph version 1 -> 2, lastBuiltVersion remains 1.
    const confirmed = await knowledge.confirmNode(f.scope, courseId, node1.id, {
      expectedVersion: 1,
      sourceVersions: { [s1.sourceId]: 1 },
    });
    expect(confirmed.version).toBe(2);
    expect((await knowledge.readSyncStatus(f.scope, courseId)).lastBuiltVersion).toBe(1);

    // Release V2: CAS retries cleanly against version 2 -> saves version 3, preserves confirmation, V3 stays queued.
    releaseExtract();
    expect(await v2Promise).toBe(true);

    const between = await service.get(f.scope, courseId);
    expect(between.version).toBe(3);
    expect(between.snapshot.nodes.find((n) => n.id === node1.id)?.status).toBe("supported");
    expect(between.sync).toEqual({
      status: "pending",
      activeJobId: v3JobId,
      lastBuiltVersion: 3,
      coveredSourceVersions: { [s1.sourceId]: 1 },
      eligibleSourceVersions: { [s1.sourceId]: 1, [s2.sourceId]: 1 },
      parsingSourceCount: 0,
    });

    // Execute queued V3 job -> reaches up_to_date covering { S1: 1, S2: 1 }, no extra V4 job spawned.
    expect(await runJob(jobs, v3JobId, makeBuildHandler({ nodeStatus: "needs_check" }))).toBe(true);

    const finalRecord = await service.get(f.scope, courseId);
    expect(finalRecord.version).toBe(4);
    // Expanding sourceVersions to include S2 intentionally resets prior whole-graph confirmations to "needs_check"
    // (while V2 above preserved "supported" on the unchanged { S1 } source set).
    expect(finalRecord.snapshot.nodes.find((n) => n.id === node1.id)?.status).toBe("needs_check");
    expect(finalRecord.snapshot.nodes).toHaveLength(2);
    expect(finalRecord.sync).toEqual({
      status: "up_to_date",
      activeJobId: null,
      lastBuiltVersion: 4,
      coveredSourceVersions: { [s1.sourceId]: 1, [s2.sourceId]: 1 },
      eligibleSourceVersions: { [s1.sourceId]: 1, [s2.sourceId]: 1 },
      parsingSourceCount: 0,
    });

    const allJobs = await f.sql`
      SELECT id FROM opening_jobs
      WHERE workspace_id = ${f.scope.workspaceId}
        AND kind = 'build-course-knowledge'
        AND payload->>'courseId' = ${courseId}`;
    expect(allJobs).toHaveLength(3);
  });

  it("handles replacesSourceId with purpose inheritance, preserves same-name non-replacement adds, and isolates other courses", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const p = principal();

    const course1 = await seedCourse("Course 1");
    const course2 = await seedCourse("Course 2");
    const s1 = await seedSource({ name: "notes.pdf", version: 1, text: "旧版讲义 S1" });

    // Attach S1 to both Course 1 and Course 2 as teaching
    await addMembershipForPrincipal(runtime, p, course1, {
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });
    await addMembershipForPrincipal(runtime, p, course2, {
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    const sync1 = await knowledge.readSyncStatus(f.scope, course1);
    const sync2 = await knowledge.readSyncStatus(f.scope, course2);
    expect(sync1.activeJobId).toBeTruthy();
    expect(sync2.activeJobId).toBeTruthy();
    expect(await runJob(jobs, sync1.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    expect(await runJob(jobs, sync2.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    // Add second file S2 with the SAME filename WITHOUT replacesSourceId -> both S1 and S2 stay attached.
    const s2 = await seedSource({ name: "notes.pdf", version: 1, text: "补充讲义 S2" });
    await addMembershipForPrincipal(runtime, p, course1, {
      assetType: "source",
      assetId: s2.sourceId,
      role: "core",
      visibility: "course",
    });
    const assetsBeforeReplace = await runtime.courses.listCourseAssets({
      workspaceId: f.scope.workspaceId,
      courseId: course1,
    });
    expect(assetsBeforeReplace.map((a) => a.assetId).sort()).toEqual([s1.sourceId, s2.sourceId].sort());

    const syncBeforeReplace = await knowledge.readSyncStatus(f.scope, course1);
    expect(await runJob(jobs, syncBeforeReplace.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    // Explicitly replace S1 with S3 (omitting purpose -> inherits "teaching" from S1)
    const s3 = await seedSource({ name: "notes-v2.pdf", version: 1, text: "新版讲义 S3" });
    const replacedMembership = await addMembershipForPrincipal(runtime, p, course1, {
      assetType: "source",
      assetId: s3.sourceId,
      role: "core",
      visibility: "course",
      replacesSourceId: s1.sourceId,
    });
    expect(replacedMembership.purpose).toBe("teaching");

    const assetsAfterReplace = await runtime.courses.listCourseAssets({
      workspaceId: f.scope.workspaceId,
      courseId: course1,
    });
    expect(assetsAfterReplace.map((a) => a.assetId).sort()).toEqual([s2.sourceId, s3.sourceId].sort());

    // Course 1's old graph is marked needs_check; Course 2 stays supported and up_to_date.
    const c1Invalidated = await knowledge.get(f.scope, course1);
    expect(c1Invalidated?.snapshot.nodes.every((n) => n.status === "needs_check")).toBe(true);
    const c2Unchanged = await knowledge.getWithSync(f.scope, course2);
    expect(c2Unchanged.snapshot.nodes.every((n) => n.status === "supported")).toBe(true);
    expect(c2Unchanged.sync?.status).toBe("up_to_date");

    const c1Pending = await knowledge.readSyncStatus(f.scope, course1);
    expect(c1Pending.status).toBe("pending");
    expect(c1Pending.activeJobId).toBeTruthy();

    expect(await runJob(jobs, c1Pending.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    const c1Final = await knowledge.getWithSync(f.scope, course1);
    expect(c1Final.sync).toMatchObject({
      status: "up_to_date",
      activeJobId: null,
      coveredSourceVersions: { [s2.sourceId]: 1, [s3.sourceId]: 1 },
      eligibleSourceVersions: { [s2.sourceId]: 1, [s3.sourceId]: 1 },
    });
    expect(c1Final.snapshot.nodes).toHaveLength(2);
  });

  it("syncs purpose restrictions, membership removal, and source exclude/delete lifecycle", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const p = principal();
    const courseId = await seedCourse("Lifecycle Sync");

    const s1 = await seedSource({ name: "s1.txt", version: 1, text: "核心讲义" });
    const sParsing = await seedSource({
      name: "parsing.pdf",
      version: 1,
      uploadState: "uploaded",
      parseState: "queued",
    });

    const m1 = await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
    });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sParsing.sourceId,
      role: "optional",
      visibility: "course",
    });

    const syncInitial = await knowledge.readSyncStatus(f.scope, courseId);
    expect(syncInitial.parsingSourceCount).toBe(1);
    expect(syncInitial.activeJobId).toBeTruthy();
    expect(await runJob(jobs, syncInitial.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    // Changing S1 purpose to mock_exam hides restricted nodes in getWithSync and enqueues empty rebuild.
    await updateMembershipPurposeForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: s1.sourceId,
      purpose: "mock_exam",
      expectedUpdatedAt: m1.updatedAt.toISOString(),
    });
    const restrictedRead = await knowledge.getWithSync(f.scope, courseId);
    expect(restrictedRead.snapshot.nodes).toEqual([]);
    expect(restrictedRead.sourceVersions).toEqual({});
    expect(restrictedRead.sync?.status).toBe("pending");
    expect(await runJob(jobs, restrictedRead.sync!.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    const afterClear = await knowledge.getWithSync(f.scope, courseId);
    expect(afterClear.sync?.status).toBe("empty");
    expect(afterClear.sync?.parsingSourceCount).toBe(1);

    // Remove sParsing, add s2, build, then exclude via actOnSource
    await removeMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sParsing.sourceId,
    });

    const s2 = await seedSource({ name: "s2.txt", version: 1, text: "将被排除的讲义" });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: s2.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });
    const syncS2 = await knowledge.readSyncStatus(f.scope, courseId);
    expect(await runJob(jobs, syncS2.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    expect((await knowledge.readSyncStatus(f.scope, courseId)).status).toBe("up_to_date");

    const storage = {
      stagingKey: (id: string) => `opening/staging/${id}`,
      finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
      deleteObject: async () => undefined,
      objectExists: async () => false,
      presignGet: async (key: string) => `https://private.invalid/${key}`,
    } as unknown as OpeningStorage;
    const sourceService = createOpeningSourceService(f.sql, storage);
    const impact = await sourceService.getSourceImpact(p, s2.sourceId);
    await sourceService.actOnSource(p, s2.sourceId, {
      action: "exclude",
      expectedVersion: impact.version,
      expectedMembershipIds: impact.courses.map((c) => c.membershipId),
    });

    const afterExclude = await knowledge.getWithSync(f.scope, courseId);
    expect(afterExclude.snapshot.nodes.length).toBeGreaterThan(0);
    expect(afterExclude.snapshot.nodes.every((n) => n.status === "needs_check")).toBe(true);
    expect(afterExclude.sync?.status).toBe("pending");
    expect(await runJob(jobs, afterExclude.sync!.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    expect((await knowledge.readSyncStatus(f.scope, courseId)).status).toBe("empty");

    // Deleting a ready built source also invalidates and rebuilds to empty
    const s3 = await seedSource({ name: "s3.txt", version: 1, text: "将被删除的讲义" });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: s3.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });
    const syncS3 = await knowledge.readSyncStatus(f.scope, courseId);
    expect(await runJob(jobs, syncS3.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    const impact3 = await sourceService.getSourceImpact(p, s3.sourceId);
    await sourceService.actOnSource(p, s3.sourceId, {
      action: "delete",
      expectedVersion: impact3.version,
      expectedMembershipIds: impact3.courses.map((c) => c.membershipId),
    });
    const afterDelete = await knowledge.getWithSync(f.scope, courseId);
    expect(afterDelete.snapshot.nodes.length).toBeGreaterThan(0);
    expect(afterDelete.snapshot.nodes.every((n) => n.status === "needs_check")).toBe(true);
    expect(afterDelete.sync?.status).toBe("pending");
    expect(await runJob(jobs, afterDelete.sync!.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    expect((await knowledge.readSyncStatus(f.scope, courseId)).status).toBe("empty");
  });

  it("D1: counts failed, zero-chunk, blank-text, and pure-image sources as unreadable while keeping queued in parsingSourceCount and recovering mixed image+text", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("D1 Unreadable Materials");

    const sFailed = await seedSource({ name: "failed.pdf", parseState: "failed" });
    const sZeroChunk = await seedSource({ name: "empty.pdf", parseState: "ready", skipChunk: true });
    const sWhitespace = await seedSource({ name: "blank.txt", parseState: "ready", text: "  \n\t  " });
    const sPureImage = await seedSource({ name: "scan.pdf", parseState: "ready", text: "", imageObjectKey: "opening/img/p1.png" });
    const sQueued = await seedSource({ name: "queued.pdf", parseState: "queued" });

    for (const src of [sFailed, sZeroChunk, sWhitespace, sPureImage, sQueued]) {
      await courses.addAssetMembership({
        workspaceId: f.scope.workspaceId,
        courseId,
        assetType: "source",
        assetId: src.sourceId,
        role: "core",
        visibility: "course",
        purpose: "teaching",
      });
    }

    const beforeRecovery = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(beforeRecovery).toEqual({
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 1,
      unreadableSourceCount: 4,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    });
    expect(await knowledge.listAuthorizedChunks(f.scope, courseId)).toEqual([]);

    // Adding a non-whitespace text chunk to the pure-image source makes it a mixed image+text eligible source.
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${randomUUID()}, ${sPureImage.sourceId}, ${sPureImage.version}, 2, '第二页正文：线性方程组', NULL)`;

    const afterRecovery = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(afterRecovery.unreadableSourceCount).toBe(3);
    expect(afterRecovery.parsingSourceCount).toBe(1);
    expect(afterRecovery.eligibleSourceVersions).toEqual({ [sPureImage.sourceId]: 1 });
    expect(afterRecovery.status).toBe("needs_rebuild");
    expect((await knowledge.listAuthorizedChunks(f.scope, courseId)).map((c) => c.sourceId)).toEqual([sPureImage.sourceId]);
  });

  it("D2: exposes terminal failed/outcome_unknown in lastFailedJob without error leakage, clears on later success, and tracks requestedJob independently", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("D2 Job Truthfulness");
    const s1 = await seedSource({ name: "s1.txt", text: "微积分基础" });
    await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId,
      courseId,
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    const j1 = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "d2-failed-job-1" });
    await runJob(jobs, j1.jobId, async () => {
      throw new Error("provider secret failure");
    });

    const afterFail = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true, requestedJobId: j1.jobId });
    expect(afterFail.lastFailedJob).toEqual({ jobId: j1.jobId, state: "failed" });
    expect(afterFail.requestedJob).toEqual({ jobId: j1.jobId, state: "failed" });
    expect("error" in (afterFail.lastFailedJob ?? {})).toBe(false);

    // A later J2 succeeds -> clears lastFailedJob, while requestedJob for J1 still truthfully reports failed.
    const j2 = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "d2-succeeded-job-2" });
    expect(await runJob(jobs, j2.jobId, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    const afterJ2 = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true, requestedJobId: j1.jobId });
    expect(afterJ2.lastFailedJob).toBeNull();
    expect(afterJ2.requestedJob).toEqual({ jobId: j1.jobId, state: "failed" });
    expect(afterJ2.status).toBe("up_to_date");
  });

  it("D3: converges cleanly to up_to_date when C=E={S1,S2}, G={S1}, and nodes are needs_check without enqueueing on repeated reconciles", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("D3 Zero-Node Subset");
    const s1 = await seedSource({ name: "s1.txt", text: "第一章 集合论" });
    const s2 = await seedSource({ name: "s2.txt", text: "封面与目录" });

    for (const src of [s1, s2]) {
      await courses.addAssetMembership({
        workspaceId: f.scope.workspaceId,
        courseId,
        assetType: "source",
        assetId: src.sourceId,
        role: "core",
        visibility: "course",
        purpose: "teaching",
      });
    }

    const r = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(r.enqueued?.created).toBe(true);
    const partialExtractHandler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: (scope, cid) => knowledge.listAuthorizedChunks(scope, cid),
      listReferencedNodeIds: (scope, cid) => knowledge.listReferencedNodeIds(scope, cid),
      get: (scope, cid) => knowledge.getForRebuild(scope, cid),
      replace: (scope, cid, input) => knowledge.replace(scope, cid, input),
      onBuildCompleted: async (scope, cid, coveredSourceVersions) => {
        await knowledge.reconcileCourseMaterials(scope, cid, { coveredSourceVersions });
      },
      extractGraph: async (chunks) => {
        const s1Chunk = chunks.find((c) => c.sourceId === s1.sourceId);
        return {
          nodes: s1Chunk
            ? [{ label: "集合论", kind: "concept", evidenceChunkIds: [s1Chunk.id], status: "needs_check" }]
            : [],
          edges: [],
        };
      },
    });
    expect(await runJob(jobs, r.enqueued!.jobId, partialExtractHandler)).toBe(true);

    const sync = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(sync).toMatchObject({
      status: "up_to_date",
      activeJobId: null,
      coveredSourceVersions: { [s1.sourceId]: 1, [s2.sourceId]: 1 },
      eligibleSourceVersions: { [s1.sourceId]: 1, [s2.sourceId]: 1 },
    });
    expect((await knowledge.reconcileCourseMaterials(f.scope, courseId)).enqueued).toBeNull();
    expect((await knowledge.reconcileCourseMaterials(f.scope, courseId)).enqueued).toBeNull();
  });

  it("D4: blocks destructive replacement on failed new version, returns 409 on new manual POST (preserving same-key replay), and rejects stale worker even if new source recovers before CAS retry", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const p = principal();
    const courseId = await seedCourse("D4 Replacement Guard");

    const s1 = await seedSource({ name: "s1.txt", text: "核心定理 S1" });
    const tSibling = await seedSource({ name: "t.txt", text: "辅助章节 T" });
    for (const src of [s1, tSibling]) {
      await addMembershipForPrincipal(runtime, p, courseId, {
        assetType: "source",
        assetId: src.sourceId,
        role: "core",
        visibility: "course",
        purpose: "teaching",
      });
    }
    const initSync = await knowledge.readSyncStatus(f.scope, courseId);
    expect(await runJob(jobs, initSync.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    const baselineRecord = await knowledge.get(f.scope, courseId);
    expect(baselineRecord?.snapshot.nodes).toHaveLength(2);
    const preBlockedReceipt = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "d4-existing-receipt-key" });

    // Replace S1 with failed S2 -> rebuildBlockedByMaterials=true, auto reconcile does not enqueue, manual POST throws 409 CONFLICT
    const s2Failed = await seedSource({ name: "s2-scan.pdf", parseState: "failed" });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: s2Failed.sourceId,
      role: "core",
      visibility: "course",
      replacesSourceId: s1.sourceId,
    });

    const blockedSync = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(blockedSync.rebuildBlockedByMaterials).toBe(true);
    expect(blockedSync.unreadableSourceCount).toBe(1);
    expect((await knowledge.reconcileCourseMaterials(f.scope, courseId)).enqueued).toBeNull();

    await expect(
      knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "d4-blocked-manual-key" }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
    // Same-key replay still returns existing receipt
    await expect(
      knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "d4-existing-receipt-key" }),
    ).resolves.toEqual({ jobId: preBlockedReceipt.jobId, kind: "build-course-knowledge", created: false });

    // Run pre-queued stale worker that extracts ONLY sibling T while S2 is failed, then pause BEFORE replace:
    // bump graph version (simulating CAS race) AND recover S2 to ready WITH text right before CAS retry.
    let enteredExtract!: () => void;
    let releaseExtract!: () => void;
    const extractEntered = new Promise<void>((resolve) => {
      enteredExtract = resolve;
    });
    const extractProceed = new Promise<void>((resolve) => {
      releaseExtract = resolve;
    });

    const staleWorkerPromise = runJob(
      jobs,
      preBlockedReceipt.jobId,
      makeBuildHandler({
        nodeStatus: "supported",
        onExtract: async (chunks) => {
          expect(chunks.map((c) => c.sourceId)).toEqual([tSibling.sourceId]);
          enteredExtract();
          await extractProceed;
        },
      }),
    );

    await extractEntered;

    // Bump version so the worker's first replace attempt hits CAS CONFLICT, AND recover S2 before CAS retry!
    await f.sql`
      UPDATE opening_course_knowledge
      SET version = version + 1
      WHERE workspace_id = ${f.scope.workspaceId} AND course_id = ${courseId}`;
    await f.sql`
      UPDATE opening_sources
      SET parse_state = 'ready'
      WHERE workspace_id = ${f.scope.workspaceId} AND id = ${s2Failed.sourceId}`;
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${randomUUID()}, ${s2Failed.sourceId}, 1, 1, '恢复后的新版核心定理 S2', NULL)`;

    releaseExtract();
    await staleWorkerPromise;

    // Stale worker job must fail instead of overwriting and deleting S1's old nodes/evidence!
    const afterStaleJob = await knowledge.readSyncStatus(f.scope, courseId, {
      includeDetails: true,
      requestedJobId: preBlockedReceipt.jobId,
    });
    expect(afterStaleJob.requestedJob).toEqual({ jobId: preBlockedReceipt.jobId, state: "failed" });
    const preserved = await knowledge.get(f.scope, courseId);
    expect(preserved?.sourceVersions).toEqual({ [s1.sourceId]: 1, [tSibling.sourceId]: 1 });
    const sortNodes = (nodes: ReadonlyArray<{ id: string; evidenceChunkIds: string[] }>) =>
      [...nodes]
        .map((n) => ({ id: n.id, evidenceChunkIds: [...n.evidenceChunkIds].sort() }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(sortNodes(preserved?.snapshot.nodes ?? [])).toEqual(
      sortNodes(baselineRecord?.snapshot.nodes ?? []),
    );
  });

  it("GPT-P1: keeps write-side and enqueue protection for source A when A replacement fails even if sibling source B switches to practice purpose", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const p = principal();
    const courseId = await seedCourse("Mixed Per-Source Protection");

    const sourceA = await seedSource({ name: "a.txt", text: "来源A核心定理" });
    const sourceB = await seedSource({ name: "b.txt", text: "来源B章节讲义" });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sourceA.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });
    const membershipB = await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sourceB.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    const initSync = await knowledge.readSyncStatus(f.scope, courseId);
    expect(await runJob(jobs, initSync.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    const baseline = await knowledge.get(f.scope, courseId);
    const nodeA = baseline!.snapshot.nodes.find((n) => n.evidenceChunkIds.includes(sourceA.chunkId!));
    expect(nodeA).toBeTruthy();

    // Replace A with failed source A2 while switching B to practice purpose (mandatory cleanup for B ONLY).
    const sourceAFailed = await seedSource({ name: "a-v2-failed.pdf", parseState: "failed" });
    await addMembershipForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sourceAFailed.sourceId,
      role: "core",
      visibility: "course",
      replacesSourceId: sourceA.sourceId,
    });
    await updateMembershipPurposeForPrincipal(runtime, p, courseId, {
      assetType: "source",
      assetId: sourceB.sourceId,
      purpose: "practice",
      expectedUpdatedAt: membershipB.updatedAt.toISOString(),
    });

    const blockedSync = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(blockedSync.rebuildBlockedByMaterials).toBe(true);
    expect(blockedSync.unreadableSourceCount).toBe(1);
    expect((await knowledge.reconcileCourseMaterials(f.scope, courseId)).enqueued).toBeNull();

    await expect(
      knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "mixed-per-source-blocked-key" }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // Direct worker write-side replace attempt with empty batch must also be rejected.
    const currentVersion = await knowledge.getVersion(f.scope, courseId);
    await expect(
      knowledge.replace(f.scope, courseId, {
        expectedVersion: currentVersion!,
        extractedSourceVersions: {},
        snapshot: { courseId, version: currentVersion! + 1, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // Verify stored row in opening_course_knowledge still preserves A's exact node ID and evidence chunk ID.
    const [storedRow] = await f.sql`
      SELECT snapshot, source_versions
      FROM opening_course_knowledge
      WHERE workspace_id = ${f.scope.workspaceId} AND course_id = ${courseId}`;
    const storedSnapshot = storedRow!.snapshot as { nodes: Array<{ id: string; evidenceChunkIds: string[] }> };
    expect(storedRow!.source_versions).toEqual({ [sourceA.sourceId]: 1, [sourceB.sourceId]: 1 });
    expect(storedSnapshot.nodes.find((n) => n.id === nodeA!.id)).toMatchObject({
      id: nodeA!.id,
      evidenceChunkIds: [sourceA.chunkId],
    });
  });

  it("Opus-B3: allows normal same-ID readable version upgrade (V@1 -> V@2) alongside an unrelated pure-image unreadable source", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("Same-ID Version Upgrade");

    const videoV = await seedSource({ name: "lecture-video.mp4", version: 1, text: "第一版转写：微分定义" });
    const pureImageB = await seedSource({
      name: "cover-scan.pdf",
      version: 1,
      parseState: "ready",
      text: "",
      imageObjectKey: "opening/img/cover.png",
    });
    for (const src of [videoV, pureImageB]) {
      await courses.addAssetMembership({
        workspaceId: f.scope.workspaceId,
        courseId,
        assetType: "source",
        assetId: src.sourceId,
        role: "core",
        visibility: "course",
        purpose: "teaching",
      });
    }

    const r1 = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(r1.enqueued?.created).toBe(true);
    expect(await runJob(jobs, r1.enqueued!.jobId, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    // Upgrade videoV in-place to version 2 (ready + readable text) while pureImageB remains unreadable.
    const v2Text = "第二版修正转写：微分与导数几何意义";
    const v2Bytes = Buffer.from(v2Text, "utf8");
    const v2Sha = createHash("sha256").update(v2Bytes).digest("hex");
    await f.sql`
      UPDATE opening_sources
      SET version = 2, bytes = ${v2Bytes.length}, sha256 = ${v2Sha}, parse_state = 'ready'
      WHERE workspace_id = ${f.scope.workspaceId} AND id = ${videoV.sourceId}`;
    await f.sql`
      INSERT INTO opening_source_versions (source_id, version, workspace_id, bytes, sha256, availability)
      VALUES (${videoV.sourceId}, 2, ${f.scope.workspaceId}, ${v2Bytes.length}, ${v2Sha}, 'available')`;
    const v2ChunkId = randomUUID();
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${v2ChunkId}, ${videoV.sourceId}, 2, 1, ${v2Text}, NULL)`;

    const beforeRebuild = await knowledge.readSyncStatus(f.scope, courseId, { includeDetails: true });
    expect(beforeRebuild.status).toBe("needs_rebuild");
    expect(beforeRebuild.unreadableSourceCount).toBe(1);
    expect(beforeRebuild.eligibleSourceVersions).toEqual({ [videoV.sourceId]: 2 });
    expect(beforeRebuild.rebuildBlockedByMaterials).toBe(false);

    const r2 = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(r2.enqueued?.created).toBe(true);
    expect(await runJob(jobs, r2.enqueued!.jobId, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    const afterRebuild = await knowledge.getWithSync(f.scope, courseId, { includeDetails: true });
    expect(afterRebuild.sourceVersions).toEqual({ [videoV.sourceId]: 2 });
    expect(afterRebuild.snapshot.nodes.map((n) => n.evidenceChunkIds)).toEqual([[v2ChunkId]]);
    expect(afterRebuild.sync).toMatchObject({
      status: "up_to_date",
      unreadableSourceCount: 1,
      rebuildBlockedByMaterials: false,
      coveredSourceVersions: { [videoV.sourceId]: 2 },
      eligibleSourceVersions: { [videoV.sourceId]: 2 },
    });
  });

  it("GPT-P1: getWithSync executes inside a REPEATABLE READ READ ONLY snapshot so concurrent worker completion cannot splice old V1 nodes with succeeded job state", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("Snapshot Consistency");

    const s1 = await seedSource({ name: "s1.txt", text: "快照测试材料" });
    await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId,
      courseId,
      assetType: "source",
      assetId: s1.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    const r1 = await knowledge.reconcileCourseMaterials(f.scope, courseId);
    expect(await runJob(jobs, r1.enqueued!.jobId, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    // Seed an active running rebuild job that will commit V2 (0 nodes) + succeeded concurrently mid-GET.
    const raceJob = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "snapshot-race-job-1" });
    await f.sql`
      UPDATE opening_jobs
      SET state = 'running', updated_at = now()
      WHERE id = ${raceJob.jobId}`;

    let sawRepeatableReadOnly = false;
    let injectedConcurrentCommit = false;
    const proxiedSql = new Proxy(f.sql, {
      get(target, prop, receiver) {
        if (prop === "begin") {
          return (cb: (tx: typeof f.sql) => Promise<unknown>) =>
            target.begin(async (tx) => {
              const proxiedTx = new Proxy(tx, {
                apply(txTarget, txThis, argArray) {
                  const [strings] = argArray as [TemplateStringsArray];
                  const queryText = Array.isArray(strings) && "raw" in strings
                    ? strings.join("?").replace(/\s+/g, " ").trim()
                    : "";
                  if (queryText === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
                    sawRepeatableReadOnly = true;
                  }
                  const pending = Reflect.apply(txTarget, txThis, argArray);
                  if (!injectedConcurrentCommit && queryText.startsWith("SELECT version, snapshot, source_versions FROM opening_course_knowledge")) {
                    injectedConcurrentCommit = true;
                    return Promise.resolve(pending).then(async (rows) => {
                      await f.sql.begin(async (writer) => {
                        const emptyV2 = { courseId, version: 2, nodes: [], edges: [] };
                        await writer`
                          UPDATE opening_course_knowledge
                          SET version = 2,
                              snapshot = ${writer.json(emptyV2 as never)},
                              source_versions = ${writer.json({} as never)},
                              updated_at = now()
                          WHERE workspace_id = ${f.scope.workspaceId} AND course_id = ${courseId}`;
                        await writer`
                          UPDATE opening_jobs
                          SET state = 'succeeded',
                              result = ${writer.json({ version: 2, coveredSourceVersions: { [s1.sourceId]: 1 } } as never)},
                              updated_at = now()
                          WHERE id = ${raceJob.jobId}`;
                      });
                      return rows;
                    });
                  }
                  return pending;
                },
              });
              return cb(proxiedTx as unknown as typeof f.sql);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const snapshotRepo = createOpeningKnowledgeRepository(proxiedSql);
    const inFlightRead = await snapshotRepo.getWithSync(f.scope, courseId, {
      includeDetails: true,
      requestedJobId: raceJob.jobId,
    });
    expect(sawRepeatableReadOnly).toBe(true);
    expect(injectedConcurrentCommit).toBe(true);
    // Single snapshot: pre-commit V1 node MUST pair with pre-commit running job state, never succeeded
    expect(inFlightRead.version).toBe(1);
    expect(inFlightRead.snapshot.nodes).toHaveLength(1);
    expect(inFlightRead.sync?.requestedJob).toEqual({ jobId: raceJob.jobId, state: "running" });
    expect(inFlightRead.sync?.activeJobId).toBe(raceJob.jobId);

    // Next read sees post-commit V2 empty graph and succeeded job state together
    const postCommitRead = await knowledge.getWithSync(f.scope, courseId, {
      includeDetails: true,
      requestedJobId: raceJob.jobId,
    });
    expect(postCommitRead.version).toBe(2);
    expect(postCommitRead.snapshot.nodes).toHaveLength(0);
    expect(postCommitRead.sync?.requestedJob).toEqual({ jobId: raceJob.jobId, state: "succeeded" });
    expect(postCommitRead.sync?.activeJobId).toBeNull();
  });

  it("GPT-P1-R2: rejects stale J1 batch after J2 commits V@2 nodes and evidence, preserving J2 exact node ID and chunk ID", async () => {
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const jobs = createOpeningJobRepository(f.sql);
    const courses = createCourseMembershipRepository(f.sql);
    const courseId = await seedCourse("Stale J1 vs J2 V2 Race");

    const videoV = await seedSource({ name: "lecture.mp4", version: 1, text: "旧版 V1 转写" });
    await courses.addAssetMembership({
      workspaceId: f.scope.workspaceId,
      courseId,
      assetType: "source",
      assetId: videoV.sourceId,
      role: "core",
      visibility: "course",
      purpose: "teaching",
    });

    // J1 starts on V@1 and pauses inside extractGraph before writeback (will produce an empty/stale batch without V@2).
    const j1 = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "r2-stale-j1" });
    expect(j1.created).toBe(true);

    let enteredJ1!: () => void;
    let releaseJ1!: () => void;
    const j1Entered = new Promise<void>((resolve) => {
      enteredJ1 = resolve;
    });
    const j1Proceed = new Promise<void>((resolve) => {
      releaseJ1 = resolve;
    });

    const j1Handler = createBuildCourseKnowledgeHandler({
      listAuthorizedChunks: (scope, cid) => knowledge.listAuthorizedChunks(scope, cid),
      listReferencedNodeIds: (scope, cid) => knowledge.listReferencedNodeIds(scope, cid),
      get: (scope, cid) => knowledge.getForRebuild(scope, cid),
      replace: (scope, cid, input) => knowledge.replace(scope, cid, input),
      extractGraph: async () => {
        enteredJ1();
        await j1Proceed;
        return { nodes: [], edges: [] };
      },
    });
    const j1Promise = runJob(jobs, j1.jobId, j1Handler);
    await j1Entered;

    // Upgrade V in-place to V@2 with a new readable chunk, then let J2 run and commit V@2 nodes + evidence.
    const v2Text = "新版 V2 核心定理与证明";
    const v2Bytes = Buffer.from(v2Text, "utf8");
    const v2Sha = createHash("sha256").update(v2Bytes).digest("hex");
    await f.sql`
      UPDATE opening_sources
      SET version = 2, bytes = ${v2Bytes.length}, sha256 = ${v2Sha}, parse_state = 'ready'
      WHERE workspace_id = ${f.scope.workspaceId} AND id = ${videoV.sourceId}`;
    await f.sql`
      INSERT INTO opening_source_versions (source_id, version, workspace_id, bytes, sha256, availability)
      VALUES (${videoV.sourceId}, 2, ${f.scope.workspaceId}, ${v2Bytes.length}, ${v2Sha}, 'available')`;
    const v2ChunkId = randomUUID();
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${v2ChunkId}, ${videoV.sourceId}, 2, 1, ${v2Text}, NULL)`;

    const j2 = await knowledge.enqueueRebuild(f.scope, courseId, { clientKey: "r2-fresh-j2-v2" });
    expect(j2.created).toBe(true);
    expect(await runJob(jobs, j2.jobId, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);

    const afterJ2 = await knowledge.get(f.scope, courseId);
    expect(afterJ2?.sourceVersions).toEqual({ [videoV.sourceId]: 2 });
    expect(afterJ2?.snapshot.nodes).toHaveLength(1);
    const j2Node = afterJ2!.snapshot.nodes[0]!;
    expect(j2Node.evidenceChunkIds).toEqual([v2ChunkId]);

    // Release stale J1: hits CAS conflict against J2's committed V@2 graph and MUST fail without overwriting.
    releaseJ1();
    await j1Promise;
    const j1Status = await knowledge.readSyncStatus(f.scope, courseId, {
      includeDetails: true,
      requestedJobId: j1.jobId,
    });
    expect(j1Status.requestedJob).toEqual({ jobId: j1.jobId, state: "failed" });

    // Even a direct replace() call at J2's exact version with stale extractedSourceVersions must be rejected.
    await expect(
      knowledge.replace(f.scope, courseId, {
        expectedVersion: afterJ2!.version,
        extractedSourceVersions: {},
        snapshot: { courseId, version: afterJ2!.version + 1, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
    await expect(
      knowledge.replace(f.scope, courseId, {
        expectedVersion: afterJ2!.version,
        extractedSourceVersions: { [videoV.sourceId]: 1 },
        snapshot: { courseId, version: afterJ2!.version + 1, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // DB must still preserve J2's exact node ID and evidence chunk ID.
    const preserved = await knowledge.get(f.scope, courseId);
    expect(preserved?.version).toBe(afterJ2!.version);
    expect(preserved?.sourceVersions).toEqual({ [videoV.sourceId]: 2 });
    expect(preserved?.snapshot.nodes).toEqual([
      expect.objectContaining({ id: j2Node.id, evidenceChunkIds: [v2ChunkId] }),
    ]);
  });
});
