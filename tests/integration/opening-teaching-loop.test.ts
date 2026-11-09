/**
 * V2-16 — First AI-led teaching loop integration (L1–L6 + understandable states).
 * Composes tip services/repos; synthetic fixture; no new DDL.
 * Dual flag injection: OPENING_TEACHING_LOOP + OPENING_TEACHING_WORKSPACE.
 * real_model stays not_run (never faked green from mocks alone).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { ActivitySpecPublishInput } from "@aistudy/contracts";
import {
  conversationResumeSchema,
  learningResumeSchema,
  type TeachingActivity,
} from "@aistudy/contracts";
import {
  createLibraryRepository,
  createOpeningTeachingCommandsRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningTeachingContentRepository,
  createOpeningTeachingActivitiesRepository,
  ensureCourseContinueActivity,
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
import { openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

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
  try {
    await f.sql.begin(async tx => {
      await tx`TRUNCATE library_revisions`;
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
      await tx`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    });
  } finally {
    await f.close();
  }
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

async function seedCourseSource(withMembership = true) {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source();
  const chunkId = await rows.chunk(sourceId);
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${f.scope.workspaceId}, 'V2-16 teaching loop', ${courseId})`;
  if (withMembership) {
    await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
      VALUES (${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  }
  return { courseId, sourceId, chunkId };
}

describe("ActivitySpec publication source trust boundary (PG)", () => {
  async function seedBoundary() {
    const { courseId, sourceId, chunkId } = await seedCourseSource(false);
    const oldChunkId = randomUUID();
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${chunkId}`;
    await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
      VALUES (${oldChunkId},${sourceId},1,1,'历史版本')`;
    const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
      clientKey: randomUUID(), intentKind: "material", intentSummary: "边界", courseId, sourceIds: [], createIntent: {},
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

  it.each([2, null])("rejects unavailable whole-source refs (version %s) without relying on chunk filtering", async version => {
    const { content, input, sourceId, snapshot } = await seedBoundary();
    // No locator: removing the explicit availability check would take the
    // known whole-source fast path, bypassing the chunk availability filter.
    const sourceRefs = [{ sourceId, version }];
    for (const expectedVersion of [0, 1]) {
      if (expectedVersion === 1) await content.publishActivitySpec(f.scope, input);
      await f.sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,availability)
        VALUES (${sourceId},${f.scope.workspaceId},2,'unavailable')
        ON CONFLICT(source_id,version) DO UPDATE SET availability='unavailable'`;
      const before = await snapshot();
      await expect(content.publishActivitySpec(f.scope, { ...input, expectedVersion, sourceRefs }))
        .rejects.toMatchObject({ code: "VALIDATION" });
      expect(await snapshot()).toEqual(before);
      await f.sql`UPDATE opening_source_versions SET availability='available' WHERE source_id=${sourceId} AND version=2`;
    }
  });

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

describe("teaching command history and rewrite atomicity (PG)", () => {
  async function ready() {
    const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
      clientKey: randomUUID(), intentKind: "topic", intentSummary: "Atomic command", sourceIds: [], createIntent: {},
    });
    return seedReadyTeachingContent(activity);
  }

  async function graph(sql: Sql = f.sql) {
    const rows = [];
    for (const table of ["library_documents", "library_blocks", "library_revisions", "opening_teaching_units",
      "opening_teaching_activity_specs", "opening_teaching_activities", "opening_workspace_history_revisions",
      "opening_jobs", "opening_outbox", "opening_budget_reservations"]) {
      rows.push(await sql`SELECT to_jsonb(t) AS row FROM ${sql(table)} t WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`);
    }
    return JSON.stringify(rows);
  }

  async function watermark() {
    return f.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
      AND owner_user_id=${f.scope.ownerUserId}`;
  }

  function rewrite(activity: TeachingActivity) {
    return { clientKey: randomUUID(), kind: "rephrase" as const, blockId: blockA,
      expectedVersion: activity.contentVersion, expectedPathVersion: activity.pathVersion, expectedRevisionNumber: 1,
      prompt: "Simpler explanation" };
  }

  // Execute all SQL unchanged; pause/fail only after the real revision write,
  // immediately before the command's spec UPDATE. No canned SQL results.
  function beforeSpec(sql: Sql, effect: (tx: TransactionSql) => Promise<void>): Sql {
    return new Proxy(sql, { get(target, property) {
      if (property === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => {
        const wrapped = new Proxy(tx, { apply(client, _self, args: [TemplateStringsArray, ...unknown[]]) {
          const query = Array.isArray(args[0]) && args[0].join("?");
          if (query && query.includes("UPDATE opening_teaching_activity_specs")) {
            return effect(tx).then(() => Reflect.apply(client, client, args));
          }
          return Reflect.apply(client, client, args);
        } });
        return callback(wrapped);
      });
      return Reflect.get(target, property);
    } });
  }

  it("waits on history before workspace/job/activity/spec/document locks, then succeeds without advancing history", async () => {
    const x = await ready(), history = await watermark();
    const jobId = randomUUID(), token = randomUUID();
    await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token)
      VALUES(${jobId},${f.scope.workspaceId},${f.scope.ownerUserId},${randomUUID()},'compile-teaching-unit','{}','running',${token})`;
    const [workspace] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
    const scope = { ...f.scope, jobExecution: { id: jobId, token, privacyEpoch: Number(workspace!.privacy_epoch) } };
    const holder = openRaceSession(), writer = openRaceSession(), probe = openRaceSession();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const opened = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([holder.ready, writer.ready, probe.ready]);
      const holding = track(holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
          AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
        entered(); await held;
      }));
      pending.push(holding);
      await Promise.race([opened, holding.then(() => { throw new Error("history holder ended before opening"); })]);
      const command = track(createOpeningTeachingCommandsRepository(writer.sql).executeCommand(scope, x.activity.id, rewrite(x.activity)));
      pending.push(command);
      await waitUntilBlocked(f.sql, writer.pid, holder.pid, "teaching command history", /opening_workspace_history_revisions/);
      await probe.sql.begin(async tx => {
        expect(await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM opening_jobs WHERE id=${jobId} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM opening_teaching_activities WHERE id=${x.activity.id} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM opening_teaching_activity_specs WHERE activity_id=${x.activity.id} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM library_documents WHERE id=${x.unit.documentId} FOR UPDATE NOWAIT`).toHaveLength(1);
      });
      release(); await holding;
      expect(await command).toMatchObject({ ok: true, revisionNumber: 2 });
      expect(await watermark()).toEqual(history);
    } finally {
      release(); await Promise.allSettled(pending);
      await Promise.all([holder.sql.end(), writer.sql.end(), probe.sql.end()]);
    }
  });

  it.each([false, true])("keeps the old complete graph outside the rewrite transaction; injected failure=%s", async fail => {
    const x = await ready(), old = await graph(), history = await watermark();
    const writer = openRaceSession(), observer = openRaceSession();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([writer.ready, observer.ready]);
      const sql = beforeSpec(writer.sql, async tx => {
        expect(await tx`SELECT revision_number FROM library_revisions WHERE document_id=${x.unit.documentId} ORDER BY revision_number`)
          .toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
        expect((await tx`SELECT current_revision_number FROM library_documents WHERE id=${x.unit.documentId}`)[0]?.current_revision_number).toBe(2);
        const blocks = await tx`SELECT content FROM library_blocks WHERE document_id=${x.unit.documentId} AND id=${blockA}`;
        expect(blocks[0]?.content).not.toEqual({ markdown: "矩阵的秩与零空间维数之和等于列数。" });
        entered(); await held;
        if (fail) throw new Error("injected command failure after revision before spec");
      });
      const request = rewrite(x.activity);
      const command = track(createOpeningTeachingCommandsRepository(sql).executeCommand(f.scope, x.activity.id, request));
      pending.push(command);
      await Promise.race([reached, command.then(() => { throw new Error("command missed spec barrier"); })]);
      expect(await graph(observer.sql)).toBe(old);
      release();
      if (fail) {
        await expect(command).rejects.toThrow("injected command failure after revision before spec");
        expect(await graph(observer.sql)).toBe(old);
      } else {
        expect(await command).toMatchObject({ ok: true, contentVersion: x.activity.contentVersion + 1, revisionNumber: 2 });
        expect(await observer.sql`SELECT revision_number FROM library_revisions WHERE document_id=${x.unit.documentId} ORDER BY revision_number`)
          .toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
        expect((await observer.sql`SELECT revision_number,version FROM opening_teaching_activity_specs WHERE activity_id=${x.activity.id}`)[0])
          .toMatchObject({ revision_number: 2, version: x.activity.contentVersion + 1 });
        expect((await observer.sql`SELECT current_revision_number FROM opening_teaching_units WHERE id=${x.unit.id}`)[0]?.current_revision_number).toBe(2);
        const [activity] = await observer.sql`SELECT content_version,checkpoint_json FROM opening_teaching_activities WHERE id=${x.activity.id}`;
        expect(activity?.content_version).toBe(x.activity.contentVersion + 1);
        expect(activity?.checkpoint_json.commandReplay[request.clientKey]).toMatchObject({ ok: true, revisionNumber: 2 });
        const committed = await graph(observer.sql);
        // CAS is intentionally ahead of replay: an old rewrite retry stays stale.
        expect(await createOpeningTeachingCommandsRepository(writer.sql).executeCommand(f.scope, x.activity.id, request))
          .toMatchObject({ ok: false, conflict: "stale_content_version" });
        expect(await graph(observer.sql)).toBe(committed);
      }
      expect(await watermark()).toEqual(history);
      expect(await observer.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      expect(await observer.sql`SELECT id FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      expect(await observer.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    } finally {
      release(); await Promise.allSettled(pending);
      await Promise.all([writer.sql.end(), observer.sql.end()]);
    }
  });

  it("maps a document advanced before rewrite to stale_revision with no partial command writes", async () => {
    const x = await ready();
    await createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId,
      expectedRevisionNumber: 1, blocks: [{ id: blockA, type: "text", content: { text: "concurrent library edit" } }] });
    const old = await graph();
    expect(await createOpeningTeachingCommandsRepository(f.sql).executeCommand(f.scope, x.activity.id, rewrite(x.activity)))
      .toMatchObject({ ok: false, conflict: "stale_revision" });
    expect(await graph()).toBe(old);
  });

  it("preserves skip/why replay, CAS precedence, mismatch, generation, revision/draft and completed/ownership gates", async () => {
    const x = await ready(), commands = createOpeningTeachingCommandsRepository(f.sql), history = await watermark();
    const skip = { clientKey: randomUUID(), kind: "skip" as const, blockId: blockA, expectedVersion: x.activity.contentVersion };
    expect(await commands.executeCommand(f.scope, x.activity.id, skip)).toMatchObject({ ok: true, pathVersion: 2 });
    expect(await commands.executeCommand(f.scope, x.activity.id, skip)).toMatchObject({ ok: true, replayed: true, pathVersion: 2 });
    const why = { ...skip, clientKey: randomUUID(), kind: "why" as const };
    expect(await commands.executeCommand(f.scope, x.activity.id, why)).toMatchObject({ ok: true, assist: { kind: "why" } });
    expect(await commands.executeCommand(f.scope, x.activity.id, why)).toMatchObject({ ok: true, replayed: true });
    const old = await graph();
    for (const [request, conflict] of [
      [{ ...skip, expectedVersion: 0 }, "stale_content_version"],
      [{ ...skip, expectedPathVersion: 1 }, "stale_path_version"],
      [{ ...skip, kind: "why" as const }, "client_key_intent_mismatch"],
      [{ ...rewrite(x.activity), expectedPathVersion: 2, expectedRevisionNumber: 99 }, "stale_revision"],
    ] as const) expect(await commands.executeCommand(f.scope, x.activity.id, request)).toMatchObject({ ok: false, conflict });
    expect(await graph()).toBe(old);
    await f.sql`UPDATE opening_teaching_activities SET generate_status='generating' WHERE id=${x.activity.id}`;
    expect(await commands.executeCommand(f.scope, x.activity.id, { ...rewrite(x.activity), expectedPathVersion: 2 }))
      .toMatchObject({ ok: false, conflict: "generate_in_flight" });
    const lostBlock = randomUUID();
    await f.sql`UPDATE opening_teaching_activities SET generate_status='ready',
      checkpoint_json=jsonb_set(checkpoint_json,'{drafts}',${f.sql.json([{ blockId: lostBlock, contentVersion: 1, draftText: "keep" }])}) WHERE id=${x.activity.id}`;
    const draftGraph = await graph();
    expect(await commands.executeCommand(f.scope, x.activity.id, { ...rewrite(x.activity), expectedPathVersion: 2 }))
      .toMatchObject({ ok: false, conflict: "draft_anchor_lost", lostBlockIds: [lostBlock] });
    expect(await graph()).toBe(draftGraph);
    await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${x.activity.id}`;
    expect(await commands.executeCommand(f.scope, x.activity.id, why)).toMatchObject({ ok: true, replayed: true });
    const completed = await graph();
    await expect(commands.executeCommand(f.scope, x.activity.id, { ...why, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(commands.executeCommand(f.otherScope, x.activity.id, why)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(commands.executeCommand({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, x.activity.id, why))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await graph()).toBe(completed);
    expect(await watermark()).toEqual(history);
    expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${x.unit.documentId}`).toHaveLength(1);
  });
});

describe("teaching root batch history fence (PG)", () => {
  const roots = ["ensure", "status", "generate", "request", "enqueue"] as const;
  type Root = typeof roots[number];
  async function seed() {
    const { courseId, sourceId } = await seedCourseSource();
    const repo = createOpeningTeachingActivitiesRepository(f.sql);
    const activity = await repo.create(f.scope, { clientKey: randomUUID(), intentKind: "material",
      intentSummary: "Batch root", courseId, sourceIds: [sourceId], createIntent: {} });
    // A real, nonempty teaching + learning graph must survive every failed root.
    await seedReadyTeachingContent(await repo.create(f.scope, { clientKey: randomUUID(), intentKind: "topic",
      intentSummary: "Existing content", courseId, sourceIds: [sourceId], createIntent: {} }));
    const learning = createOpeningLearningRepository(f.sql);
    const session = await learning.createSession(f.scope, { activityId: activity.id, courseId, sourceIds: [sourceId], skillLabel: "Batch" });
    await learning.insertObservation(f.scope, { sessionId: session.id, courseId, sourceIds: [sourceId], skillLabel: "Batch",
      answer: "Existing answer", outcome: "incorrect", assistance: "independent", clientKey: randomUUID() });
    const jobId = randomUUID(), token = randomUUID();
    await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token)
      VALUES(${jobId},${f.scope.workspaceId},${f.scope.ownerUserId},${randomUUID()},'compile-teaching-unit','{}','running',${token})`;
    const [workspace] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
    return { activity, courseId, jobId, token,
      scope: { ...f.scope, jobExecution: { id: jobId, token, privacyEpoch: Number(workspace!.privacy_epoch) } } };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  function run(sql: Sql, root: Root, x: Seed) {
    const repo = createOpeningTeachingActivitiesRepository(sql);
    switch (root) {
      case "ensure": return ensureCourseContinueActivity(sql, x.scope, x.courseId);
      case "status": return repo.setStatus(x.scope, x.activity.id, { status: "paused", expectedUpdatedAt: x.activity.updatedAt });
      case "generate": return repo.setGenerateStatus(x.scope, x.activity.id, "generating", { from: ["ready"] });
      case "request": return repo.requestCompile(x.scope, x.activity.id, "batch-request");
      case "enqueue": return repo.enqueueCompileTeachingUnit(x.scope, { activityId: x.activity.id, mode: "generate",
        clientKey: "batch-enqueue", expectedContentVersion: 0, sourceIds: x.activity.sourceIds });
    }
  }
  async function graph() {
    const rows = [];
    for (const table of ["courses", "course_asset_memberships", "opening_teaching_activities", "opening_teaching_activity_specs",
      "opening_teaching_units", "library_documents", "library_blocks", "library_revisions", "opening_learning_sessions",
      "opening_learning_observations", "opening_source_versions", "opening_workspace_history_revisions",
      "opening_learning_history_revisions", "opening_jobs", "opening_outbox", "opening_budget_reservations"]) {
      rows.push(await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(table)} t
        WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`);
    }
    return JSON.stringify(rows);
  }
  const watermark = () => f.sql`SELECT revision FROM opening_workspace_history_revisions
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;

  it.each(roots)("%s waits on history before business locks; other workspace progresses; watermark stays unchanged", async root => {
    const x = await seed(), before = await graph(), history = await watermark();
    const other = await createOpeningTeachingActivitiesRepository(f.sql).create(f.otherScope, { clientKey: randomUUID(),
      intentKind: "topic", intentSummary: "Independent workspace", createIntent: {} });
    const holder = openRaceSession(), writer = openRaceSession(), probe = openRaceSession();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([holder.ready, writer.ready, probe.ready]);
      const holding = track(holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
          AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
        entered(); await held;
      }));
      pending.push(holding);
      await Promise.race([opened, holding.then(() => { throw new Error("history holder ended early"); })]);
      const mutation = track(run(writer.sql, root, x)); pending.push(mutation);
      await waitUntilBlocked(f.sql, writer.pid, holder.pid, `batch ${root}`, /opening_workspace_history_revisions/);
      await probe.sql.begin(async tx => {
        expect(await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM opening_jobs WHERE id=${x.jobId} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM courses WHERE id=${x.courseId} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await tx`SELECT id FROM opening_teaching_activities WHERE id=${x.activity.id} FOR UPDATE NOWAIT`).toHaveLength(1);
      });
      expect(await createOpeningTeachingActivitiesRepository(probe.sql).setGenerateStatus(f.otherScope, other.id, "failed")).toBe(true);
      expect(await createOpeningTeachingActivitiesRepository(probe.sql).setGenerateStatus(f.otherScope, x.activity.id, "failed")).toBe(false);
      expect(await graph()).toBe(before);
      release(); await holding; await mutation;
      expect(await graph()).not.toBe(before);
      expect(await watermark()).toEqual(history);
    } finally {
      release(); await Promise.allSettled(pending);
      await Promise.all([holder.sql.end(), writer.sql.end(), probe.sql.end()]);
    }
  });

  it.each([
    "missing status", "status CAS", "completed status", "missing request", "completed request", "queued request",
    "content request", "source request", "purpose request", "dedup request", "ordinary from-set", "missing generate",
    "stale token", "stale state", "stale epoch", "missing course", "completed enqueue", "purpose enqueue", "dedup enqueue",
  ])("priority %s returns the original no-write result while history is held", async name => {
    const x = await seed(), repo = createOpeningTeachingActivitiesRepository(f.sql);
    if (name.startsWith("completed")) await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${x.activity.id}`;
    if (name === "queued request") await f.sql`UPDATE opening_teaching_activities SET generate_status='queued' WHERE id=${x.activity.id}`;
    if (name === "content request") await f.sql`UPDATE opening_teaching_activities SET content_version=1 WHERE id=${x.activity.id}`;
    if (name === "source request") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id)
      VALUES(${f.scope.workspaceId},${x.activity.sourceIds[0]!})`;
    if (name.startsWith("purpose")) {
      await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE course_id=${x.courseId}`;
      // A read-only request probe must not journal versions on its way to this failure.
      await f.sql`DELETE FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}`;
    }
    const input = { activityId: x.activity.id, mode: "generate" as const, clientKey: "priority-dedup", expectedContentVersion: 0 };
    if (name.startsWith("dedup")) {
      await repo.enqueueCompileTeachingUnit(f.scope, input);
      await f.sql`UPDATE opening_teaching_activities SET generate_status='ready' WHERE id=${x.activity.id}`;
    }
    if (name === "stale state") await f.sql`UPDATE opening_jobs SET state='cancelled' WHERE id=${x.jobId}`;
    const before = await graph(), holder = openRaceSession(), writer = openRaceSession();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([holder.ready, writer.ready]);
      const holding = track(holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
          AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
        entered(); await held;
      }));
      pending.push(holding);
      await Promise.race([opened, holding.then(() => { throw new Error("priority history holder ended early"); })]);
      const commands = createOpeningTeachingActivitiesRepository(writer.sql);
      let operation: Promise<unknown>, expected: { code: string; message: string } | false;
      if (name.includes("status")) {
        operation = commands.setStatus(f.scope, name === "missing status" ? randomUUID() : x.activity.id,
          { status: "active", ...(name === "status CAS" ? { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" } : {}) });
        expected = name === "missing status" ? { code: "NOT_FOUND", message: "teaching activity not found" }
          : { code: "CONFLICT", message: name === "status CAS" ? "teaching activity updated_at mismatch" : "completed teaching activity cannot be reopened" };
      } else if (name.includes("request")) {
        operation = commands.requestCompile(f.scope, name === "missing request" ? randomUUID() : x.activity.id,
          name === "dedup request" ? input.clientKey : "priority-request");
        expected = name === "missing request" ? { code: "NOT_FOUND", message: "teaching activity not found" }
          : name === "source request" ? { code: "VALIDATION", message: "source unavailable or privacy-excluded" }
          : { code: "CONFLICT", message: name === "completed request" ? "completed teaching activity cannot generate new content"
            : name === "queued request" ? "teaching content is already being generated"
            : name === "content request" ? "teaching content already exists"
            : name === "purpose request" ? "课程资料用途已变化，不能作为本次教材；请重新选择材料。" : "compile request clientKey already used" };
      } else if (name.includes("enqueue")) {
        operation = commands.enqueueCompileTeachingUnit(f.scope, { ...input, expectedContentVersion: 1 });
        expected = { code: "CONFLICT", message: name === "completed enqueue" ? "completed teaching activity cannot generate new content"
          : name === "purpose enqueue" ? "课程资料用途已变化，不能作为本次教材；请重新选择材料。" : "idempotency payload differs for the same key" };
      } else if (name === "missing course") {
        operation = ensureCourseContinueActivity(writer.sql, f.scope, randomUUID());
        expected = { code: "NOT_FOUND", message: "course not found" };
      } else {
        const scope = name.startsWith("stale") ? { ...x.scope, jobExecution: { ...x.scope.jobExecution,
          ...(name === "stale token" ? { token: randomUUID() } : {}),
          ...(name === "stale epoch" ? { privacyEpoch: x.scope.jobExecution.privacyEpoch + 1 } : {}) } } : f.scope;
        operation = commands.setGenerateStatus(scope, name === "missing generate" ? randomUUID() : x.activity.id, "failed", { from: ["queued"] });
        expected = name.startsWith("stale") ? { code: "CONFLICT", message: "job execution is no longer current" } : false;
      }
      pending.push(track(operation));
      // Await under the live holder, using Vitest's unchanged default deadline.
      // A misplaced history wait cannot be mistaken for an ordinary rejection.
      if (expected === false) expect(await operation).toBe(false);
      else await expect(operation).rejects.toMatchObject(expected);
      expect(await graph()).toBe(before);
    } finally {
      release(); await Promise.allSettled(pending);
      await Promise.all([holder.sql.end(), writer.sql.end()]);
    }
  });

  it.each(["active", "completed"] as const)("%s enqueue dedup success still waits on the history guard", async status => {
    const x = await seed(), repo = createOpeningTeachingActivitiesRepository(f.sql);
    const input = { activityId: x.activity.id, mode: "generate" as const, clientKey: "guarded-dedup", expectedContentVersion: 0 };
    const first = await repo.enqueueCompileTeachingUnit(f.scope, input);
    if (status === "completed") await repo.setStatus(f.scope, x.activity.id, { status });
    const before = await graph(), holder = openRaceSession(), writer = openRaceSession();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([holder.ready, writer.ready]);
      const holding = track(holder.sql.begin(async tx => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}
          AND owner_user_id=${f.scope.ownerUserId} FOR UPDATE`;
        entered(); await held;
      }));
      pending.push(holding);
      await Promise.race([opened, holding.then(() => { throw new Error("dedup history holder ended early"); })]);
      const replay = track(createOpeningTeachingActivitiesRepository(writer.sql).enqueueCompileTeachingUnit(f.scope, input));
      pending.push(replay);
      await waitUntilBlocked(f.sql, writer.pid, holder.pid, "enqueue dedup history", /opening_workspace_history_revisions/);
      expect(await graph()).toBe(before);
      release(); await holding;
      expect(await replay).toEqual({ ...first, created: false });
      expect(await graph()).toBe(before);
    } finally {
      release(); await Promise.allSettled(pending);
      await Promise.all([holder.sql.end(), writer.sql.end()]);
    }
  });

  it.each(roots)("%s rolls back its actual writes, jobs and outbox on injected failure", async root => {
    const x = await seed(), before = await graph();
    let injected = false;
    const pattern = root === "ensure" ? "INSERT INTO opening_teaching_activities"
      : root === "request" || root === "enqueue" ? "INSERT INTO opening_outbox" : "UPDATE opening_teaching_activities";
    const sql = new Proxy(f.sql, { get(target, key) {
      if (key === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
        apply(client, _self, args: [TemplateStringsArray, ...unknown[]]) {
          const query = Array.isArray(args[0]) && args[0].join("?");
          const result = Reflect.apply(client, client, args);
          if (query && query.includes(pattern)) return Promise.resolve(result).then(() => {
            injected = true; throw new Error("injected after batch root write");
          });
          return result;
        },
      })));
      return Reflect.get(target, key);
    } });
    await expect(run(sql, root, x)).rejects.toThrow("injected after batch root write");
    expect(injected).toBe(true);
    expect(await graph()).toBe(before);
  });

  it("preserves status CAS, generation from-set, stale execution, compile dedup and original errors", async () => {
    const x = await seed(), repo = createOpeningTeachingActivitiesRepository(f.sql), before = await graph();
    await expect(repo.setStatus(x.scope, x.activity.id, { status: "paused", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "teaching activity updated_at mismatch" });
    expect(await repo.setGenerateStatus(x.scope, x.activity.id, "failed", { from: ["queued"] })).toBe(false);
    await expect(repo.setGenerateStatus({ ...x.scope, jobExecution: { ...x.scope.jobExecution, token: randomUUID() } }, x.activity.id, "failed"))
      .rejects.toMatchObject({ code: "CONFLICT", message: "job execution is no longer current" });
    await expect(ensureCourseContinueActivity(f.sql, x.scope, randomUUID()))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "course not found" });
    await expect(repo.requestCompile(x.scope, randomUUID(), "missing-activity"))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "teaching activity not found" });
    await expect(repo.enqueueCompileTeachingUnit(x.scope, { activityId: x.activity.id, mode: "generate", clientKey: "short", expectedContentVersion: 0 }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "clientKey is too short" });
    await expect(repo.setStatus(f.otherScope, x.activity.id, { status: "paused" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "teaching activity not found" });
    expect(await graph()).toBe(before);
    const history = await watermark(), id = await ensureCourseContinueActivity(f.sql, x.scope, x.courseId);
    expect(await ensureCourseContinueActivity(f.sql, x.scope, x.courseId)).toBe(id);
    const input = { activityId: x.activity.id, mode: "generate" as const, clientKey: "compile-dedup", expectedContentVersion: 0 };
    const first = await repo.enqueueCompileTeachingUnit(x.scope, input), committed = await graph();
    expect(await repo.enqueueCompileTeachingUnit(x.scope, input)).toEqual({ ...first, created: false });
    await expect(repo.enqueueCompileTeachingUnit(x.scope, { ...input, expectedContentVersion: 1 }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "idempotency payload differs for the same key" });
    await expect(repo.requestCompile(x.scope, x.activity.id, "already-queued"))
      .rejects.toMatchObject({ code: "CONFLICT", message: "teaching content is already being generated" });
    expect(await graph()).toBe(committed);
    expect(await watermark()).toEqual(history);
  });
});

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
