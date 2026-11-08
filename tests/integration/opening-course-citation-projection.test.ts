import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assembleTeachingEvidencePack, compileCurrentActivity, proposeTeachingOutline } from "@aistudy/ai";
import { createOpeningSourceChunksRepository, createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository } from "@aistudy/database";
import { projectCourseCitationCoverage } from "../../packages/domain/src/opening/course-citation-coverage";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

it("projects every persisted block in the pinned current rejected revision, without exposing hidden keys", async () => {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source("uploaded", 0), chunkId = await rows.chunk(sourceId, 0);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "citation projection", sourceIds: [sourceId], createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Coverage fixture",
    blocks: [{ id: randomUUID(), type: "text", content: { text: "Initial body" } }] });
  const chunks = await createOpeningSourceChunksRepository(f.sql).listForSources(f.scope, [sourceId]);
  const outline = proposeTeachingOutline({ activityId: activity.id, intentKind: "topic", intentSummary: "coverage",
    sourceIds: [sourceId], chunks, maxItems: 1 });
  const compiled = compileCurrentActivity({ outline, focusItemId: outline.focusItemId, teachingUnitId: unit.id,
    expectedContentVersion: 0, revisionNumber: 1,
    pack: assembleTeachingEvidencePack({ chunks, query: "evidence", maxCharacters: 4000 }),
    modelOutput: { itemTitles: [], blocks: [
      { type: "text", text: "source evidence", citedChunkIds: [chunkId] },
      { type: "formula", text: "x = 0", citedChunkIds: [] },
      { type: "example", text: "source evidence", citedChunkIds: [randomUUID()] },
      ...Array.from({ length: 5 }, (_, n) => [
        { type: "prompt" as const, text: `private-prompt-${n}`, citedChunkIds: n === 0 ? [chunkId] : [] },
        { type: "answer_key" as const, text: `private-solution-${n}`, citedChunkIds: n === 0 ? [chunkId] : [] },
      ]).flat(),
    ] } });
  const written = await content.writeUnitBlocks(f.scope, unit.id, compiled.libraryBlocks);
  await content.publishActivitySpec(f.scope, { ...compiled.publishInput, revisionNumber: written.revisionNumber,
    verificationStatus: "rejected" });
  // Unpublished latest body must not replace the pinned current spec's population.
  await content.writeUnitBlocks(f.scope, unit.id, [{ id: randomUUID(), type: "text", content: { text: "unpublished" } }]);
  const spec = await content.getActivitySpec(f.scope, activity.id);
  expect(spec?.verificationStatus).toBe("rejected");
  const revision = await content.readRevision(f.scope, spec!.documentId, spec!.revisionNumber);
  const coverage = projectCourseCitationCoverage({ blockOrder: spec!.blockOrder, blocks: revision.blocks });
  expect(coverage).toEqual({ total: 13, bound: 3, missing: 9, mismatch: 1, unknown: 0, factualSupport: "unverified",
    byRole: {
      teach: { total: 2, bound: 1, missing: 1, mismatch: 0, unknown: 0 },
      example: { total: 1, bound: 0, missing: 0, mismatch: 1, unknown: 0 },
      prompt: { total: 5, bound: 1, missing: 4, mismatch: 0, unknown: 0 },
      answer_key: { total: 5, bound: 1, missing: 4, mismatch: 0, unknown: 0 },
    } });
  const client = await content.getClientInit(f.scope, activity.id);
  expect(client!.blocks.filter(block => block.role === "answer_key").every(block => block.content === null)).toBe(true);
  const serialized = JSON.stringify(coverage);
  for (const secret of ["private-prompt", "private-solution", sourceId, chunkId, "refs", "blockId"])
    expect(serialized).not.toContain(secret);
  // Scope remains the real reader's responsibility, not projection's.
  await expect(content.getActivitySpec(f.otherScope, activity.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(content.readRevision(f.otherScope, spec!.documentId, spec!.revisionNumber)).rejects.toBeDefined();
  // This is reader → projection evidence only, not route aggregation or HTTP wiring.
});

it("keeps persisted legacy, malformed and copied-identity bindings unknown", async () => {
  const content = createOpeningTeachingContentRepository(f.sql);
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "legacy coverage", sourceIds: [], createIntent: {},
  });
  const blocks = [
    { id: randomUUID(), type: "text", content: { text: "legacy", citedChunkIds: [randomUUID()] } },
    { id: randomUUID(), type: "prompt", content: { text: "private-question", citationBinding: { status: "bound" } } },
    { id: randomUUID(), type: "answer_key", content: { answer: "private-key", citationBinding: {
      blockId: randomUUID(), role: "answer_key", status: "missing", refs: [], factualSupport: "unverified" } } },
  ];
  const unit = await content.createUnit(f.scope, { title: "Legacy", blocks });
  const blockOrder = blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, position,
    role: position === 0 ? "teach" as const : position === 1 ? "prompt" as const : "answer_key" as const }));
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: unit.currentRevisionNumber, blockOrder });
  const spec = await content.getActivitySpec(f.scope, activity.id);
  const revision = await content.readRevision(f.scope, spec!.documentId, spec!.revisionNumber);
  expect(projectCourseCitationCoverage({ blockOrder: spec!.blockOrder, blocks: revision.blocks }))
    .toMatchObject({ total: 3, bound: 0, missing: 0, mismatch: 0, unknown: 3, factualSupport: "unverified" });
});
