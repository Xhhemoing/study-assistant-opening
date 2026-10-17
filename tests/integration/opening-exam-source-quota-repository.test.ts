import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExamBindInput, ExamPack } from "@aistudy/contracts";
import { createOpeningSourceRepository } from "@aistudy/database";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import type { ExamPublicSourceWriter } from "../../packages/database/src/repositories/opening-exam-integration-binding";
import { readOpeningSourceQuotaUsage, type OpeningSourceQuota } from "../../packages/database/src/repositories/opening-source-quota";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "exam-quota-fixture", version: "1", title: "数学复习", description: "公开概述",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson", topicId: "limits", title: "极限", summary: "检查条件", steps: ["先看定义域"],
    workedExample: "公开例题", pitfalls: ["遗漏条件"] }],
  questions: [{ id: "question", topicId: "limits", skillId: "limit-laws", familyId: "family", lessonId: "lesson",
    pool: "training", difficulty: "foundation", prompt: "Question", options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }],
    answer: "a", explanation: "Private answer", hint: "Private hint", estimatedMinutes: 2 }],
  sourceItems: [], weekPlan: [], limitations: ["复习用途"],
};
const objectQuota = { maxBytes: 10_000, maxObjects: 1 };
const upload = { name: "quota.txt", mime: "text/plain" as const, bytes: 4, sha256: "a".repeat(64) };
let f: OpeningFixture;
let courseId: string;

beforeEach(async () => {
  f = await createOpeningFixture();
  courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Exam quota',${courseId})`;
});
afterEach(async () => {
  if (!f) return;
  try {
    await f.sql`DELETE FROM opening_source_versions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_learning_history_revisions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM users WHERE id IN (${f.scope.ownerUserId},${f.otherScope.ownerUserId})`;
  } finally {
    await f.close();
  }
});

function input(overrides: Partial<ExamBindInput> = {}): ExamBindInput {
  return { clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [], materials: [], ...overrides };
}
function integration(quota: OpeningSourceQuota) {
  // Only SQL is real: this spy acknowledges the original without writing to S3.
  const writePublicSource = vi.fn<ExamPublicSourceWriter>(async () => {});
  return { repository: createOpeningExamIntegrationRepository(f.sql, pack, { quota, writePublicSource }), writePublicSource };
}
async function counts() {
  const [row] = await f.sql`SELECT
    (SELECT count(*)::int FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}) AS sprints,
    (SELECT count(*)::int FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}) AS sources,
    (SELECT count(*)::int FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}) AS versions,
    (SELECT count(*)::int FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
      WHERE s.workspace_id=${f.scope.workspaceId}) AS chunks,
    (SELECT count(*)::int FROM course_asset_memberships WHERE workspace_id=${f.scope.workspaceId}) AS memberships,
    (SELECT count(*)::int FROM opening_course_knowledge WHERE workspace_id=${f.scope.workspaceId}) AS graphs,
    (SELECT count(*)::int FROM opening_exam_bindings b JOIN opening_exam_sprints s ON s.id=b.sprint_id
      WHERE s.workspace_id=${f.scope.workspaceId}) AS bindings,
    (SELECT count(*)::int FROM opening_exam_integration_commands c JOIN opening_exam_sprints s ON s.id=c.sprint_id
      WHERE s.workspace_id=${f.scope.workspaceId}) AS commands`;
  return row;
}

describe("exam public source quota with real PostgreSQL and a storage spy", () => {
  it("rejects an over-byte-limit first binding before storage and rolls all binding records back", async () => {
    const { repository, writePublicSource } = integration({ maxBytes: 1, maxObjects: 10 });
    await expect(repository.bind(f.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writePublicSource).not.toHaveBeenCalled();
    expect(await counts()).toEqual({ sprints: 0, sources: 0, versions: 0, chunks: 0,
      memberships: 0, graphs: 0, bindings: 0, commands: 0 });
    expect(await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, 1)).toEqual({ bytes: 0n, objects: 0n });
  });

  it("serializes a binding against an ordinary upload reservation under their shared workspace quota", async () => {
    const { repository, writePublicSource } = integration(objectQuota);
    const sources = createOpeningSourceRepository(f.sql, { quota: objectQuota });
    const results = await Promise.allSettled([repository.bind(f.scope, input()), sources.create(f.scope, upload)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
    const bindingResult = results[0]!;
    const bindWon = bindingResult.status === "fulfilled";
    expect(writePublicSource).toHaveBeenCalledTimes(bindWon ? 1 : 0);
    const rows = await f.sql`SELECT id,bytes,upload_state FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.upload_state).toBe(bindWon ? "uploaded" : "pending");
    if (bindingResult.status === "fulfilled") {
      expect(rows[0]!.id).toBe(bindingResult.value.binding!.packSourceId);
      expect(writePublicSource.mock.calls[0]![0].sourceId).toBe(rows[0]!.id);
    }
    expect(await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, objectQuota.maxBytes))
      .toEqual({ bytes: BigInt(String(rows[0]!.bytes)), objects: 1n });
    const saved = await counts();
    expect(saved).toMatchObject({ sprints: bindWon ? 1 : 0, sources: 1, versions: bindWon ? 1 : 0,
      chunks: bindWon ? 2 : 0, memberships: bindWon ? 1 : 0, graphs: bindWon ? 1 : 0,
      bindings: bindWon ? 1 : 0, commands: bindWon ? 1 : 0 });

    const forgedScope = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
    await expect(repository.bind(forgedScope, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sources.create(forgedScope, upload)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await counts()).toEqual(saved);
    expect(writePublicSource).toHaveBeenCalledTimes(bindWon ? 1 : 0);
    expect((await sources.create(f.otherScope, upload)).workspaceId).toBe(f.otherScope.workspaceId);
    expect(await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, objectQuota.maxBytes))
      .toEqual({ bytes: BigInt(String(rows[0]!.bytes)), objects: 1n });
  });

  it("replays and updates a binding at full object quota without rewriting or charging its current version twice", async () => {
    const { repository, writePublicSource } = integration(objectQuota);
    const firstInput = input();
    const first = await repository.bind(f.scope, firstInput);
    const saved = await counts();
    const usage = await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, objectQuota.maxBytes);
    expect(saved).toEqual({ sprints: 1, sources: 1, versions: 1, chunks: 2,
      memberships: 1, graphs: 1, bindings: 1, commands: 1 });
    expect(usage).toEqual({ bytes: BigInt(writePublicSource.mock.calls[0]![0].body.byteLength), objects: 1n });
    expect((await repository.bind(f.scope, firstInput)).binding).toEqual(first.binding);
    expect(await counts()).toEqual(saved);
    expect((await repository.bind(f.scope, input())).binding).toEqual(first.binding);
    expect(await counts()).toEqual({ ...saved, commands: 2 });
    expect(writePublicSource).toHaveBeenCalledTimes(1);
    expect(await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, objectQuota.maxBytes)).toEqual(usage);
    await expect(createOpeningSourceRepository(f.sql, { quota: objectQuota }).create(f.scope, upload))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await counts()).toEqual({ ...saved, commands: 2 });
    expect(await readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, objectQuota.maxBytes)).toEqual(usage);
  });
});
