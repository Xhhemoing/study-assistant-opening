/**
 * V2-16 — First AI-led teaching loop integration (L1–L6 + understandable states).
 * Composes tip services/repos; synthetic fixture; no new DDL.
 * Dual flag injection: OPENING_TEACHING_LOOP + OPENING_TEACHING_WORKSPACE.
 * real_model stays not_run (never faked green from mocks alone).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActivitySpecPublishInput } from "@aistudy/contracts";
import {
  conversationResumeSchema,
  learningResumeSchema,
  type TeachingActivity,
} from "@aistudy/contracts";
import {
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningTeachingContentRepository,
  createOpeningTeachingActivitiesRepository,
} from "@aistudy/database";
import { probeMaterialsAvailability } from "@aistudy/domain";
import {
  BUDGET_CONFIRM_CTA,
  BUDGET_CONFIRM_LEAD,
  isBudgetRelatedHardBlocker,
  needsBudgetConfirmCta,
  type AiReadinessChecklistItem,
} from "../../apps/web/src/features/opening/assistant/ai-readiness-model";
import { createOpeningTeachingActivityService } from "../../apps/web/src/features/opening/teaching/activity-service";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { isOpeningTeachingLoopEnabled } from "../../apps/web/src/features/opening/teaching/teaching-loop-flag";
import { isOpeningTeachingWorkspaceEnabled } from "../../apps/web/src/features/opening/teaching/teaching-workspace-flag";
import { createOpeningTeachingResumeService } from "../../apps/web/src/features/opening/teaching/resume-service";
import { isTeachingWorkspaceContentUsable } from "../../apps/web/src/features/opening/teaching/teaching-workspace";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;

/** Dual flag injection for trial (Plan ACCEPT lock #3). PR-H: server switches only; no NEXT_PUBLIC_* twins. */
function injectDualTeachingFlags() {
  process.env.OPENING_TEACHING_LOOP = "1";
  process.env.OPENING_TEACHING_WORKSPACE = "1";
}

beforeAll(async () => {
  injectDualTeachingFlags();
  f = await createOpeningFixture();
});

afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});

beforeEach(async () => {
  injectDualTeachingFlags();
  await f.sql`TRUNCATE
    opening_teaching_activity_specs,
    opening_teaching_units,
    opening_teaching_activities,
    opening_learning_activity_history_revisions,
    opening_skill_evidence,
    opening_learning_eligibility,
    opening_learning_observations,
    opening_help_exposures,
    opening_learning_attempts,
    opening_learning_item_versions,
    opening_problem_refs,
    opening_learning_sessions,
    opening_privacy_exclusions,
    opening_source_versions,
    opening_outbox,
    opening_jobs,
    opening_source_chunks,
    opening_sources,
    course_asset_memberships,
    library_blocks,
    library_revisions,
    library_documents
    RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM courses WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});

async function seedCourseSource() {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source();
  const chunkId = await rows.chunk(sourceId);
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${f.scope.workspaceId}, 'V2-16 teaching loop', ${courseId})`;
  return { courseId, sourceId, chunkId };
}

describe("ActivitySpec publication source trust boundary (PG)", () => {
  async function seedBoundary() {
    const { courseId, sourceId, chunkId } = await seedCourseSource();
    const oldChunkId = randomUUID();
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${chunkId}`;
    await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
      VALUES (${oldChunkId},${sourceId},1,1,'历史版本')`;
    const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
      clientKey: randomUUID(), intentKind: "material", intentSummary: "边界", courseId, sourceIds: [sourceId], createIntent: {},
    });
    const content = createOpeningTeachingContentRepository(f.sql);
    const unit = await content.createUnit(f.scope, { title: "边界", blocks: [{ id: randomUUID(), type: "text", content: { text: "seed" } }] });
    const input: ActivitySpecPublishInput = { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
      revisionNumber: 1, blockOrder: [], sourceRefs: [{ sourceId, version: 2, page: 1, chunkId }] };
    const snapshot = async () => ({
      spec: await content.getActivitySpec(f.scope, activity.id),
      activities: await f.sql`SELECT * FROM opening_teaching_activities WHERE id=${activity.id}`,
      units: await f.sql`SELECT * FROM opening_teaching_units WHERE id=${unit.id}`,
      revisions: await f.sql`SELECT * FROM library_revisions WHERE document_id=${unit.documentId} ORDER BY revision_number`,
    });
    return { content, input, courseId, sourceId, chunkId, oldChunkId, snapshot };
  }

  it("publishes valid current refs, accepts numeric string versions and preserves soft-idempotency", async () => {
    const { content, input, sourceId } = await seedBoundary();
    expect(await f.sql`SELECT asset_id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toHaveLength(0);
    input.sourceRefs![0]!.version = "2";
    const spec = await content.publishActivitySpec(f.scope, input);
    expect(spec).toMatchObject({ version: 1, sourceRefs: input.sourceRefs });
    expect(await content.publishActivitySpec(f.scope, input)).toEqual(spec);
  });

  it.each(["invented chunk", "non-UUID chunk", "foreign workspace whole source", "nonexistent version",
    "old chunk with current version", "out-of-range page", "chunk-page mismatch", "wrong source chunk", "missing source", "unavailable version"] as const)(
    "rejects %s without changing spec, activity, unit or revision (initial and replacement)", async kind => {
      const { content, input, sourceId, oldChunkId, snapshot } = await seedBoundary();
      const ref = { ...input.sourceRefs![0]! };
      if (kind === "invented chunk") ref.chunkId = randomUUID();
      if (kind === "missing source") ref.sourceId = randomUUID();
      if (kind === "non-UUID chunk") ref.chunkId = "invented-not-a-uuid";
      if (kind === "nonexistent version") ref.version = 999;
      if (kind === "old chunk with current version") ref.chunkId = oldChunkId;
      if (kind === "out-of-range page") { ref.page = 99; ref.chunkId = null; }
      if (kind === "chunk-page mismatch") {
        await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES (${sourceId},2,2,'第二页')`;
        ref.page = 2;
      }
      if (kind === "wrong source chunk") {
        const otherSource = await backupRows(f.sql, f.scope).source("uploaded", 2);
        ref.chunkId = await backupRows(f.sql, f.scope).chunk(otherSource, 2);
      }
      if (kind === "foreign workspace whole source") {
        // No membership or locator/version-journal dependency: removing the source
        // workspace predicate alone would make this publication succeed.
        ref.sourceId = await backupRows(f.sql, f.otherScope).source("uploaded", 2);
        ref.chunkId = null; ref.page = null;
      }
      for (const expectedVersion of [0, 1]) {
        if (expectedVersion === 1) await content.publishActivitySpec(f.scope, input);
        if (kind === "unavailable version") await f.sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,availability)
          VALUES (${sourceId},${f.scope.workspaceId},2,'unavailable')
          ON CONFLICT(source_id,version) DO UPDATE SET availability='unavailable'`;
        const before = await snapshot();
        await expect(content.publishActivitySpec(f.scope, { ...input, expectedVersion, sourceRefs: [input.sourceRefs![0]!, ref] }))
          .rejects.toMatchObject({ code: kind === "nonexistent version" ? "CONFLICT" : "VALIDATION" });
        expect(await snapshot()).toEqual(before);
        if (kind === "unavailable version") await f.sql`DELETE FROM opening_source_versions WHERE source_id=${sourceId} AND version=2`;
      }
    },
  );

  it.each(["historical chunk", "historical whole source", "journal-only version", "unpinned whole source", "unpinned chunk"] as const)(
    "publishes workspace-only nonmember refs: %s", async kind => {
      const { content, input, sourceId, oldChunkId } = await seedBoundary();
      const ref = { sourceId, version: 1 as number | null, chunkId: null as string | null, page: null as number | null };
      if (kind === "historical chunk") { ref.chunkId = oldChunkId; ref.page = 1; }
      if (kind === "journal-only version") {
        ref.version = 0;
        await f.sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,availability)
          VALUES (${sourceId},${f.scope.workspaceId},0,'available')`;
      }
      if (kind === "unpinned whole source") {
        ref.version = null;
        await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${sourceId}`;
        await f.sql`UPDATE opening_sources SET upload_state='pending',parse_state='queued' WHERE id=${sourceId}`;
      }
      if (kind === "unpinned chunk") { ref.version = null; ref.chunkId = oldChunkId; }
      input.sourceRefs = [ref];
      expect(await content.publishActivitySpec(f.scope, input)).toMatchObject({ version: 1, sourceRefs: [ref] });
    },
  );

  it("returns the existing spec on equivalent replay after replacement makes its refs unavailable", async () => {
    const { content, input, sourceId, snapshot } = await seedBoundary();
    const spec = await content.publishActivitySpec(f.scope, input);
    await f.sql`UPDATE opening_sources SET version=3 WHERE id=${sourceId}`;
    await f.sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,availability)
      VALUES (${sourceId},${f.scope.workspaceId},2,'unavailable')
      ON CONFLICT(source_id,version) DO UPDATE SET availability='unavailable'`;
    await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${sourceId} AND source_version=2`;
    const before = await snapshot();
    expect(await content.publishActivitySpec(f.scope, input)).toEqual(spec);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps archived course-route NOT_FOUND ahead of invalid source validation", async () => {
    const { content, input, courseId, snapshot } = await seedBoundary();
    const courseRoute = { goalId: randomUUID(), goalRevision: 1, requirementId: randomUUID(), requirementRevision: 1,
      stableSkillId: randomUUID(), requirementKey: "archived", action: "diagnose" };
    await f.sql`UPDATE opening_teaching_activities SET goal_json=${f.sql.json({ courseRoute })} WHERE id=${input.activityId}`;
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    const before = await snapshot();
    await expect(content.publishActivitySpec(f.scope, { ...input, sourceRefs: [{ sourceId: randomUUID() }] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await snapshot()).toEqual(before);
  });

  it("preflight success cannot authorize publication after source deletion", async () => {
    const { content, input, sourceId, snapshot } = await seedBoundary();
    await content.validateActivitySourceRefs(f.scope, input);
    await backupRows(f.sql, f.scope).exclude(sourceId);
    const before = await snapshot();
    await expect(content.publishActivitySpec(f.scope, input)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await snapshot()).toEqual(before);
  });
});

const blockA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const blockB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

/** Synthetic ready teaching content: unit + publish ActivitySpec (no live model). */
async function seedReadyTeachingContent(activity: TeachingActivity) {
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, {
    title: "Rank–nullity synthetic unit",
    blocks: [
      {
        id: blockA,
        type: "text",
        content: { markdown: "矩阵的秩与零空间维数之和等于列数。" },
      },
      {
        id: blockB,
        type: "prompt",
        content: { prompt: "计算 2×2 矩阵的秩。" },
      },
    ],
  });
  const blockOrder = [
    { blockId: blockA, position: 0, blockType: "text", role: "teach" as const },
    { blockId: blockB, position: 1, blockType: "prompt", role: "prompt" as const },
  ];
  await content.publishActivitySpec(f.scope, {
    activityId: activity.id,
    teachingUnitId: unit.id,
    expectedVersion: activity.contentVersion,
    revisionNumber: unit.currentRevisionNumber,
    expectedRevisionNumber: unit.currentRevisionNumber,
    blockOrder,
    sourceRefs: activity.sourceIds.map((sourceId) => ({ sourceId, version: 1 })),
  });
  const refreshed = await createOpeningTeachingActivityService(f.sql).get(
    f.scope,
    activity.id,
  );
  const clientInit = await content.getClientInit(f.scope, activity.id);
  return { unit, clientInit, activity: refreshed };
}

describe("V2-16 teaching loop flags (dual injection)", () => {
  it("T1 dual flags on after injection; default-off when unset", () => {
    expect(isOpeningTeachingLoopEnabled(process.env)).toBe(true);
    expect(isOpeningTeachingWorkspaceEnabled(process.env)).toBe(true);
    expect(isOpeningTeachingLoopEnabled({})).toBe(false);
    expect(isOpeningTeachingWorkspaceEnabled({})).toBe(false);
  });
});

describe("V2-16 teaching loop L1–L6", () => {
  it("L1–L6 enter → ready teach → skip command → attempt → pause/checkpoint → resume", async () => {
    const activities = createOpeningTeachingActivityService(f.sql, { OPENING_TEACHING_COMPILER_ENABLED: "0" });
    const commands = createOpeningTeachingCommandService(f.sql);
    const resume = createOpeningTeachingResumeService(f.sql);
    const learning = createOpeningLearningRepository(f.sql);
    const attempts = createOpeningLearningAttemptRepository(f.sql);
    const { courseId, sourceId, chunkId } = await seedCourseSource();

    // L1 enter — owned activity under fixture workspace + course + admitted sources
    const created = await activities.create(f.scope, {
      clientKey: `loop-enter-${randomUUID()}`,
      intentKind: "topic",
      intentSummary: "Rank–nullity first loop unit",
      courseId,
      sourceIds: [sourceId],
      createIntent: {
        intentKind: "topic",
        intentSummary: "Rank–nullity first loop unit",
        courseId,
      },
    });
    expect(created.courseId).toBe(courseId);
    expect(created.ownerUserId).toBe(f.scope.ownerUserId);
    expect(created.generateStatus).toBe("ready");

    const associated = await activities.associateCourse(f.scope, created.id, {
      courseId,
    });
    expect(associated.courseId).toBe(courseId);

    // L2 AI teach (synthetic ready fixture — not live model)
    const { clientInit, activity: readyActivity } =
      await seedReadyTeachingContent(created);
    expect(clientInit).not.toBeNull();
    expect(clientInit!.blocks.length).toBeGreaterThan(0);
    expect(isTeachingWorkspaceContentUsable(readyActivity, clientInit)).toBe(
      true,
    );

    await f.sql`UPDATE opening_teaching_activities
      SET generate_status = 'queued' WHERE id = ${created.id}`;
    const queued = await activities.get(f.scope, created.id);
    expect(isTeachingWorkspaceContentUsable(queued, clientInit)).toBe(false);
    await f.sql`UPDATE opening_teaching_activities
      SET generate_status = 'ready' WHERE id = ${created.id}`;

    // L3 local ask — skip CAS-ok; stale expectedVersion forces conflict/reread
    const skipOk = await commands.execute(f.scope, created.id, {
      clientKey: `loop-skip-${randomUUID()}`,
      kind: "skip",
      blockId: blockA,
      expectedVersion: readyActivity.contentVersion,
    });
    expect(skipOk).toMatchObject({ ok: true, kind: "skip" });
    if (skipOk.ok) {
      expect(skipOk.pathVersion).toBeGreaterThan(readyActivity.pathVersion);
    }

    const stale = await commands.execute(f.scope, created.id, {
      clientKey: `loop-stale-${randomUUID()}`,
      kind: "skip",
      blockId: blockB,
      expectedVersion: 0,
    });
    expect(stale).toMatchObject({
      ok: false,
      conflict: "stale_content_version",
    });

    // Seed V2-11 prefs before pause so L5 can assert preserve
    const prefRows = await f.sql`
      SELECT checkpoint_json FROM opening_teaching_activities WHERE id = ${created.id}`;
    const prevCp = (prefRows[0]?.checkpoint_json ?? {}) as Record<string, unknown>;
    await f.sql`
      UPDATE opening_teaching_activities
      SET checkpoint_json = ${f.sql.json({ ...prevCp, interventionPrefs: { quietMode: true } } as never)}
      WHERE id = ${created.id}`;

    // L4 attempt feedback — session scoped to this teaching activity
    const sessionId = randomUUID();
    await f.sql`INSERT INTO opening_learning_sessions
      (id, workspace_id, owner_user_id, course_id, activity_id, skill_label, source_ids)
      VALUES (
        ${sessionId}, ${f.scope.workspaceId}, ${f.scope.ownerUserId},
        ${courseId}, ${created.id}, 'rank-nullity', ${[sourceId]}
      )`;
    const attempt = await attempts.create(f.scope, {
      sessionId,
      clientKey: `loop-attempt-${randomUUID()}`,
      teachingBlock: { blockId: blockB, contentVersion: readyActivity.contentVersion },
      problem: {
        sourceId,
        chunkId,
        physicalPage: 1,
        stemSnapshot: "rank of I_2?",
        artifactKind: "reference_item",
      },
    });
    const saved = await learning.insertObservation(f.scope, {
      attemptId: attempt.id,
      sessionId,
      courseId,
      skillLabel: "rank-nullity",
      sourceIds: [sourceId],
      problemId: attempt.problemId,
      answer: "2",
      outcome: "correct",
      assistance: "independent",
      clientKey: `loop-obs-${randomUUID()}`,
    });

    // L5 pause + checkpoint
    const paused = await resume.setStatus(f.scope, created.id, {
      status: "paused",
    });
    expect(paused.status).toBe("paused");

    const afterSkip = await activities.get(f.scope, created.id);
    const checkpoint = await resume.saveCheckpoint(f.scope, created.id, {
      expectedVersion: afterSkip.contentVersion,
      currentBlockId: blockB,
      drafts: [
        {
          blockId: blockB,
          contentVersion: afterSkip.contentVersion,
          draftText: "rank draft",
        },
      ],
    });
    expect(checkpoint).toMatchObject({ ok: true });
    if (checkpoint.ok) {
      expect(checkpoint.checkpointJson.interventionPrefs).toEqual({
        quietMode: true,
      });
      expect(Array.isArray(checkpoint.checkpointJson.commandLog)).toBe(true);
      expect(
        (checkpoint.checkpointJson.commandLog as unknown[]).length,
      ).toBeGreaterThan(0);
    }

    // L6 LearningResume package — owned gates; ≠ ConversationResume
    const package_ = await resume.getResume(f.scope, created.id);
    const parsed = learningResumeSchema.parse(package_);
    expect(parsed.activityId).toBe(created.id);
    expect(parsed.status).toBe("paused");
    expect(parsed.gates.permission).toBe("owned");
    expect(parsed.gates.job).toBe("ready");
    expect(parsed.gates.materials).toBe("available");
    expect(parsed.actualAttempts.length).toBeGreaterThanOrEqual(1);
    expect(parsed.actualAttempts.some((a) => a.attemptId === attempt.id)).toBe(
      true,
    );
    expect(parsed.summary?.status).toBe("skipped");
    expect(parsed).toHaveProperty("thoughtTrain");
    expect(parsed).toHaveProperty("continuableActions");
    expect(conversationResumeSchema.safeParse(parsed).success).toBe(false);

    // L7 optional — openProblems derive without inventing eligibility
    expect(Array.isArray(parsed.openProblems)).toBe(true);

    // QA-01: fresh reads recover the durable answer without any browser draft or replay.
    const content = createOpeningTeachingContentRepository(f.sql);
    const readSaved = () => content.getSubmittedAttempt(f.scope, created.id, blockB, readyActivity.contentVersion);
    expect(await readSaved()).toMatchObject({ attempt: { id: attempt.id }, observation: { id: saved.id, answer: "2" } });
    expect(await content.getSubmittedAttempt(f.scope, created.id, blockA, readyActivity.contentVersion)).toBeNull();
    await expect(content.getSubmittedAttempt(f.otherScope, created.id, blockB, readyActivity.contentVersion)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(content.getSubmittedAttempt(f.scope, created.id, blockB, readyActivity.contentVersion + 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await resume.setStatus(f.scope, created.id, { status: "completed" });
    expect(await readSaved()).toMatchObject({ observation: { answer: "2" } });
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${f.scope.workspaceId},${sourceId})`;
    await expect(readSaved()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id=${f.scope.workspaceId} AND source_id=${sourceId}`;
    expect(await readSaved()).toMatchObject({ observation: { id: saved.id, answer: "2" } });
    const revised = await learning.reviseObservation(f.scope, {
      rootObservationId: saved.id, revisesObservationId: saved.id, expectedHead: saved.id,
      clientKey: randomUUID(), reason: "Correct my answer", revisionKind: "replace",
      replacement: { answer: "rank is 2", outcome: "unverified", assistance: "independent" },
    });
    expect(await readSaved()).toMatchObject({ observation: { id: revised.headObservationId, answer: "rank is 2" } });
    await learning.reviseObservation(f.scope, {
      rootObservationId: saved.id, revisesObservationId: revised.headObservationId, expectedHead: revised.headObservationId,
      clientKey: randomUUID(), reason: "Retract this answer", revisionKind: "retract",
    });
    expect(await readSaved()).toMatchObject({ attempt: { id: attempt.id }, observation: null });
  });
});

describe("V2-16 understandable states", () => {
  it("T-state-course: no course association when course missing; enter without course stays null", async () => {
    const activities = createOpeningTeachingActivityService(f.sql);
    const created = await activities.create(f.scope, {
      clientKey: `loop-nocourse-${randomUUID()}`,
      intentKind: "question",
      intentSummary: "Why is there no course yet?",
      createIntent: { intentKind: "question" },
    });
    expect(created.courseId).toBeNull();
    // Not a ready workspace claim — no published clientInit
    const content = createOpeningTeachingContentRepository(f.sql);
    const clientInit = await content.getClientInit(f.scope, created.id);
    expect(clientInit).toBeNull();
    expect(isTeachingWorkspaceContentUsable(created, clientInit)).toBe(false);

    const missingCourseId = randomUUID();
    await expect(
      activities.associateCourse(f.scope, created.id, {
        courseId: missingCourseId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("T-state-model / T-state-budget: ai-readiness hard blockers surface understandable copy", () => {
    const modelFail: AiReadinessChecklistItem[] = [
      {
        key: "daily_budget",
        ok: true,
        detail: "",
        fixHint: "",
        severity: "hard",
      },
      {
        key: "available_model",
        ok: false,
        detail: "missing_key",
        fixHint: "配置模型密钥",
        severity: "hard",
      },
    ];
    expect(isBudgetRelatedHardBlocker(modelFail[1]!)).toBe(true);
    expect(needsBudgetConfirmCta(modelFail)).toBe(true);

    const budgetFail: AiReadinessChecklistItem[] = [
      {
        key: "daily_budget",
        ok: false,
        detail: "cap not confirmed",
        fixHint: "",
        severity: "hard",
      },
      {
        key: "available_model",
        ok: true,
        detail: "",
        fixHint: "",
        severity: "hard",
      },
    ];
    expect(needsBudgetConfirmCta(budgetFail)).toBe(true);
    expect(BUDGET_CONFIRM_LEAD.length).toBeGreaterThan(0);
    expect(BUDGET_CONFIRM_CTA.length).toBeGreaterThan(0);
    expect(BUDGET_CONFIRM_LEAD).toContain("日额度");
  });

  it("T-state-parse: source without chunks / not admit-ready → VALIDATION (not silent ready)", async () => {
    const activities = createOpeningTeachingActivityService(f.sql);
    const badSourceId = randomUUID();
    await f.sql`INSERT INTO opening_sources
      (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (
        ${badSourceId}, ${f.scope.workspaceId}, 'parse-incomplete.txt', 'text/plain',
        12, ${"b".repeat(64)}, 1, 'uploaded', 'queued'
      )`;
    await expect(
      activities.create(f.scope, {
        clientKey: `loop-parse-${randomUUID()}`,
        intentKind: "material",
        intentSummary: "Parse incomplete material",
        sourceIds: [badSourceId],
        createIntent: { intentKind: "material", sourceIds: [badSourceId] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("T-state-withdrawn: privacy-excluded source → resume materials unavailable/partial", async () => {
    const activities = createOpeningTeachingActivityService(f.sql);
    const resume = createOpeningTeachingResumeService(f.sql);
    const { courseId, sourceId } = await seedCourseSource();
    const created = await activities.create(f.scope, {
      clientKey: `loop-withdraw-${randomUUID()}`,
      intentKind: "material",
      intentSummary: "Withdrawn source loop",
      courseId,
      sourceIds: [sourceId],
      createIntent: {
        intentKind: "material",
        courseId,
        sourceIds: [sourceId],
      },
    });

    await f.sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id, deleted_at)
      VALUES (${f.scope.workspaceId}, ${sourceId}, now())`;

    const package_ = await resume.getResume(f.scope, created.id);
    expect(package_.gates.permission).toBe("owned");
    expect(["unavailable", "partial"]).toContain(package_.gates.materials);
    expect(package_.gates.unavailableSourceIds).toContain(sourceId);
    // Domain probe mirrors fail-soft unavailable when no ids remain available
    const domain = probeMaterialsAvailability(created.sourceIds, []);
    expect(domain.materials).toBe("unavailable");
  });
});
