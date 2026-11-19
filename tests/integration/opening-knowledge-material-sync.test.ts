import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCourseMembershipRepository,
  createOpeningJobRepository,
  createOpeningKnowledgeRepository,
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
  parseState?: "not_started" | "queued" | "running" | "ready";
  text?: string;
} = {}) {
  const id = randomUUID();
  const version = options.version ?? 1;
  const uploadState = options.uploadState ?? "uploaded";
  const parseState = options.parseState ?? "ready";
  const text = options.text ?? `材料内容 ${id}`;
  const bytes = Buffer.from(text, "utf8");
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
  if (uploadState === "uploaded" && parseState === "ready") {
    chunkId = randomUUID();
    await f.sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text, image_object_key)
      VALUES (${chunkId}, ${id}, ${version}, 1, ${text}, NULL)`;
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
    expect(finalRecord.snapshot.nodes.find((n) => n.id === node1.id)?.status).toBe("supported");
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
    expect(afterDelete.snapshot.nodes.every((n) => n.status === "needs_check")).toBe(true);
    expect(afterDelete.sync?.status).toBe("pending");
    expect(await runJob(jobs, afterDelete.sync!.activeJobId!, makeBuildHandler({ nodeStatus: "supported" }))).toBe(true);
    expect((await knowledge.readSyncStatus(f.scope, courseId)).status).toBe("empty");
  });
});
