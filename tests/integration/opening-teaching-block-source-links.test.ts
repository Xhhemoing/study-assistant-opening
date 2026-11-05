// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository, createSqlClient } from "@aistudy/database";
import { activitySpecPublishInputSchema, type TeachingBlockRef } from "@aistudy/contracts";
import { createOpeningApi } from "../../apps/web/src/features/opening/client/api";
import { TeachingBlockItem } from "../../apps/web/src/features/opening/teaching/teaching-block-item";
import { backupRows } from "./opening-backup-records-fixture";

let sql: ReturnType<typeof createSqlClient>;
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
beforeAll(async () => {
  sql = createSqlClient(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB).toString());
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${scope.ownerUserId},${scope.ownerUserId + "@example.com"},'Block sources','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
});
afterAll(async () => { await sql?.end({ timeout: 5 }); });

it("saved library → pinned client init → strict HTTP client → block item preserves only this block's versioned citations", async () => {
  const rows = backupRows(sql, scope);
  const a = await rows.source("uploaded", 2), b = await rows.source("uploaded", 5), unused = await rows.source("uploaded", 9);
  const ca = await rows.chunk(a, 2), cb = await rows.chunk(b, 5), cu = await rows.chunk(unused, 9);
  await rows.chunk(a, 4);
  await rows.chunk(b, 7);
  await sql`UPDATE opening_source_chunks SET page=3 WHERE id=${ca}`;
  await sql`UPDATE opening_source_chunks SET page=11 WHERE id=${cb}`;
  const activity = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "引用定位", sourceIds: [a, b, unused], createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(sql);
  const unit = await content.createUnit(scope, { title: "引用讲义", blocks: [{ id: randomUUID(), type: "text", content: { text: "初始讲义" } }] });
  const makeBlock = (type: string, text: string, citedChunkIds?: string[]) => ({ id: randomUUID(), type,
    content: { text, ...(citedChunkIds ? { citedChunkIds } : {}), href: "https://untrusted.example/" } });
  const blocks = [makeBlock("text", "实际讲解", [ca, cb, ca, "missing", "unversioned"]),
    makeBlock("text", "旧讲解"), makeBlock("prompt", "问题", [cu]), makeBlock("answer_key", "隐藏答案", [cu])];
  const revision = await content.writeUnitBlocks(scope, unit.id, blocks);
  const blockOrder: TeachingBlockRef[] = blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, position,
    role: block.type === "answer_key" ? "answer_key" : block.type === "prompt" ? "prompt" : "teach" }));
  await content.publishActivitySpec(scope, activitySpecPublishInputSchema.parse({ activityId: activity.id, teachingUnitId: unit.id,
    expectedVersion: 0, revisionNumber: revision.revisionNumber, blockOrder,
    sourceRefs: [{ sourceId: a, version: 2, page: 3, chunkId: ca }, { sourceId: b, version: "5", page: 11, chunkId: cb },
      { sourceId: unused, version: 9, page: 1, chunkId: cu }],
  }));
  // Historical reads remain supported: versions can advance after publication.
  // Seed the pre-boundary unversioned metadata explicitly; new publication rejects it.
  await sql`UPDATE opening_sources SET version=4 WHERE id=${a}`;
  await sql`UPDATE opening_sources SET version=7 WHERE id=${b}`;
  await sql`UPDATE opening_teaching_activity_specs SET source_refs=source_refs ||
    ${sql.json([{ sourceId: a, chunkId: "unversioned" }])}::jsonb WHERE activity_id=${activity.id}`;
  // A subsequent saved revision must not change the already-published body.
  await content.writeUnitBlocks(scope, unit.id, [makeBlock("text", "未发布的新内容", [cu])]);
  const response = await content.getClientInit(scope, activity.id);
  expect(response?.revisionNumber).toBe(revision.revisionNumber);
  expect(response?.blocks[3]?.content).toBeNull();
  expect(JSON.stringify(response?.blocks[3])).not.toContain(cu);
  const api = createOpeningApi(async () => new Response(JSON.stringify(response), { status: 200 }));
  const init = await api.getTeachingClientInit(activity.id);
  const host = document.createElement("div");
  host.innerHTML = init.blocks.map(block => renderToStaticMarkup(createElement(TeachingBlockItem, {
    block, sourceRefs: init.sourceRefs, focusStatus: "current", showCommands: false, activityId: activity.id,
    contentVersion: init.contentVersion ?? 1, pathVersion: 1, returnDisabled: false, whyAvailable: false, api,
    onSuccess: () => undefined, onConflict: () => undefined, onReread: () => undefined,
  }))).join("");
  expect([...host.querySelectorAll("a")].map(link => link.getAttribute("href"))).toEqual([
    `/opening/library?tab=materials&source=${a}&version=2&page=3`,
    `/opening/library?tab=materials&source=${b}&version=5&page=11`,
  ]);
  expect(host.querySelectorAll("summary")).toHaveLength(1);
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).toContain("片段 missing · 无法定位");
  expect(host.textContent).toContain("版本未确认");
  expect(host.textContent).toContain("旧讲解");
  expect(host.textContent).not.toContain("隐藏答案");
  expect(host.innerHTML).not.toContain(cu);
  expect(host.innerHTML).not.toContain("untrusted.example");
  expect(host.textContent).not.toContain("未发布的新内容");
});
