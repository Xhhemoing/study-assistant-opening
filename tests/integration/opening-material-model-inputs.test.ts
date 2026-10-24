import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot, MaterialManifest, Scope, SourceChunk } from "@aistudy/contracts";
import { segmentMaterialChunks, type BudgetedRepository } from "@aistudy/ai";
import {
  createOpeningKnowledgeRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningMaterialManifestRepository,
  createOpeningSourceChunksRepository,
  createOpeningSourceEmbeddingsRepository,
  type OpeningJobRecord,
  type SourceIndexSnapshot,
} from "@aistudy/database";
import { createIndexSourceHandler, type IndexSourceDeps } from "../../apps/worker/src/jobs/index-source";
import { invalidateMaterialDerived } from "../../packages/database/src/repositories/opening-material-derived";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { awaitAllSettled, closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

// Real PostgreSQL/pgvector repositories only; no external provider/model calls.
let f: OpeningFixture;
const model = { modelKey: "material-policy-fixture:3", dimensions: 3 };
const mixed: MaterialManifest = {
  role: "mixed",
  sections: [
    { startPage: 1, endPage: 1, role: "lecture" },
    { startPage: 2, endPage: 2, role: "exercise" },
    { startPage: 3, endPage: 3, role: "exam_spec" },
    { startPage: 4, endPage: 4, role: "answer_key" },
    { startPage: 5, endPage: 5, role: "solution" },
  ],
  questions: [], answers: [],
};
const unrestricted: MaterialManifest = { role: "lecture", sections: [], questions: [], answers: [] };

beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`DELETE FROM opening_course_knowledge WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM courses WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`UPDATE workspaces SET privacy_epoch=0 WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});
afterAll(async () => {
  if (!f) return;
  try {
    // The final case leaves source-free learning sessions referencing activities.
    // Break that explicit dependency before deleting the isolated workspaces.
    await f.reset();
    await f.sql`DELETE FROM opening_learning_sessions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM opening_learning_item_versions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.sql`DELETE FROM users WHERE id IN (${f.scope.ownerUserId},${f.otherScope.ownerUserId})`;
  } finally { await f.close(); }
});

async function linkedCourse(scope: Scope, sourceId: string) {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Material policy course',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships
    (id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course')`;
  return courseId;
}

async function seedMaterial(scope = f.scope) {
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'mixed.pdf','application/pdf',512,${"ab".repeat(32)},0,'uploaded','running')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},0,${scope.workspaceId},512,${"ab".repeat(32)},'available')`;
  const courseId = await linkedCourse(scope, sourceId);
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(scope, { sourceId, sourceVersion: 0, chunks: [
    { page: 1, text: "Lecture: definition of a function", imageObjectKey: null },
    { page: 2, text: "Exercise: identify the domain", imageObjectKey: null },
    { page: 3, text: "Exam scope: functions and limits", imageObjectKey: null },
    { page: 4, text: "SECRET ANSWER: the domain is the real line", imageObjectKey: null },
    { page: 5, text: "", imageObjectKey: "fixtures/secret-solution.png" },
    { page: 6, text: "UNCLASSIFIED PAGE must not reach a model", imageObjectKey: null },
    { page: null, text: "", imageObjectKey: "fixtures/unknown-page.png" },
  ].map(chunk => ({ ...chunk, slideLabel: null, startMs: null, endMs: null })) });
  const snapshot = (await createOpeningSourceEmbeddingsRepository(f.sql).snapshot(scope, sourceId))!;
  expect(snapshot.sourceVersion).toBe(0);
  return { scope, courseId, sourceId, snapshot };
}
type Material = Awaited<ReturnType<typeof seedMaterial>>;
const chunkAt = (snapshot: SourceIndexSnapshot, page: number) => snapshot.chunks.find(chunk => chunk.page === page)!;
const ids = (chunks: readonly SourceChunk[]) => chunks.map(chunk => chunk.id).sort();
const vectors = (snapshot: SourceIndexSnapshot) => segmentMaterialChunks(snapshot.chunks)
  .filter(segment => segment.chunk.text.trim()).map(segment => ({ ...segment, vector: [1, 0, 0] }));

async function classify(material: Material, manifest = mixed, expectedRevision = 0) {
  return createOpeningMaterialManifestRepository(f.sql).write(material.scope, material.sourceId, {
    sourceVersion: material.snapshot.sourceVersion, expectedRevision, manifest,
  });
}

function graphFor(material: Material): KnowledgeSnapshot {
  const { courseId, snapshot } = material;
  const [clean, exercise, answer, combined, image] = Array.from({ length: 5 }, () => randomUUID());
  const node = (id: string, label: string, pages: number[]) => ({ id, courseId, label, kind: "concept" as const,
    status: "supported" as const, evidenceChunkIds: pages.map(page => chunkAt(snapshot, page).id) });
  return { courseId, version: 0, nodes: [
    node(clean!, "Function definition", [1]), node(exercise!, "Domain exercise", [2]),
    node(answer!, "Answer-derived concept", [4]), node(combined!, "Mixed-provenance concept", [1, 4]),
    node(image!, "Image-derived solution", [5]),
  ], edges: [
    { from: clean!, to: exercise!, kind: "prerequisite", status: "supported", evidenceChunkIds: [chunkAt(snapshot, 1).id] },
    { from: clean!, to: exercise!, kind: "applies_to", status: "supported", evidenceChunkIds: [chunkAt(snapshot, 4).id] },
    { from: answer!, to: clean!, kind: "prerequisite", status: "supported", evidenceChunkIds: [chunkAt(snapshot, 1).id] },
    { from: image!, to: exercise!, kind: "prerequisite", status: "suggested", evidenceChunkIds: [] },
  ] };
}
async function saveGraph(material: Material) {
  return createOpeningKnowledgeRepository(f.sql).replace(material.scope, material.courseId, {
    expectedVersion: 0, snapshot: graphFor(material), sourceVersions: { [material.sourceId]: material.snapshot.sourceVersion },
  });
}
async function sideEffects(scope = f.scope) {
  const [row] = await f.sql`SELECT
    (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${scope.workspaceId}) AS jobs,
    (SELECT count(*)::int FROM opening_outbox WHERE workspace_id=${scope.workspaceId}) AS outbox,
    (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}) AS budgets,
    (SELECT count(*)::int FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}) AS attempts,
    (SELECT count(*)::int FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId}) AS observations`;
  return row;
}

describe("OPT03 material model-input admission", () => {
  it.each(["lecture", "exercise", "exam_spec"] as const)("retains unclassified compatibility and explicitly allowed %s content, including version zero", async role => {
    const material = await seedMaterial();
    const knowledge = createOpeningKnowledgeRepository(f.sql), embeddings = createOpeningSourceEmbeddingsRepository(f.sql);
    expect(ids(await knowledge.listAuthorizedChunks(f.scope, material.courseId))).toEqual(ids(material.snapshot.chunks));
    await classify(material, { role, sections: [], questions: [], answers: [] });
    const current = (await embeddings.snapshot(f.scope, material.sourceId))!;
    expect(ids(current.chunks)).toEqual(ids(material.snapshot.chunks));
    expect(ids(await knowledge.listAuthorizedChunks(f.scope, material.courseId))).toEqual(ids(current.chunks));
    await expect(embeddings.assertCurrent(f.scope, current)).resolves.toBeUndefined();
    await expect(knowledge.assertExtractionBatch(f.scope, material.courseId, current.chunks)).resolves.toBeUndefined();
  });

  it.each(["answer_key", "solution"] as const)("withholds an entire %s source from extraction, embedding and paid reindex", async role => {
    const material = await seedMaterial();
    const knowledge = createOpeningKnowledgeRepository(f.sql), embeddings = createOpeningSourceEmbeddingsRepository(f.sql);
    await embeddings.store(f.scope, material.snapshot, model, vectors(material.snapshot));
    const before = await sideEffects();
    await classify(material, { role, sections: [], questions: [], answers: [] });
    expect((await embeddings.snapshot(f.scope, material.sourceId))?.chunks).toEqual([]);
    expect(await knowledge.listAuthorizedChunks(f.scope, material.courseId)).toEqual([]);
    expect(await embeddings.listIndexedKeys(f.scope, material.snapshot, model)).toEqual([]);
    expect(await embeddings.hasIndex(f.scope, { ...model, sourceIds: [material.sourceId] })).toBe(false);
    await expect(embeddings.reindex(f.scope, material.sourceId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(embeddings.assertCurrent(f.scope, material.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(knowledge.assertExtractionBatch(f.scope, material.courseId, material.snapshot.chunks)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sideEffects()).toEqual(before);
  });

  it("allows only classified teaching pages in mixed sources, withholding answer/solution images, gaps and null pages", async () => {
    const material = await seedMaterial();
    const embeddings = createOpeningSourceEmbeddingsRepository(f.sql), knowledge = createOpeningKnowledgeRepository(f.sql);
    await embeddings.store(f.scope, material.snapshot, model, vectors(material.snapshot));
    await classify(material);
    const current = (await embeddings.snapshot(f.scope, material.sourceId))!;
    expect(current.chunks.map(chunk => chunk.page)).toEqual([1, 2, 3]);
    expect(ids(await knowledge.listAuthorizedChunks(f.scope, material.courseId))).toEqual(ids(current.chunks));
    expect((await embeddings.authorizeChunks(f.scope, material.snapshot.chunks)).chunks).toEqual(current.chunks);
    await expect(knowledge.assertExtractionBatch(f.scope, material.courseId, current.chunks)).resolves.toBeUndefined();
    expect(await embeddings.listIndexedKeys(f.scope, current, model)).toEqual(expect.arrayContaining(current.chunks.map(chunk => `${chunk.id}:0`)));
    expect(await embeddings.listIndexedKeys(f.scope, current, model)).toHaveLength(3);
    expect(ids((await embeddings.search(f.scope, { ...model, sourceIds: [material.sourceId], vector: [1, 0, 0] })).map(row => row.chunk))).toEqual(ids(current.chunks));
  });

  it("rechecks page policy even without an epoch change and rolls back a late mixed embedding batch or graph", async () => {
    const material = await seedMaterial();
    const embeddings = createOpeningSourceEmbeddingsRepository(f.sql), knowledge = createOpeningKnowledgeRepository(f.sql);
    // Simulate old/imported same-version metadata: rejection must not depend solely on the writer's epoch bump.
    await f.sql`UPDATE opening_source_versions SET material_manifest=${f.sql.json(mixed)} WHERE source_id=${material.sourceId} AND version=0`;
    await expect(embeddings.assertCurrent(f.scope, material.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(knowledge.assertExtractionBatch(f.scope, material.courseId, material.snapshot.chunks)).rejects.toMatchObject({ code: "VALIDATION" });
    const lateRows = vectors(material.snapshot).filter(row => row.chunk.page === 1 || row.chunk.page === 4);
    expect(lateRows.map(row => row.chunk.page)).toEqual([1, 4]);
    await expect(embeddings.store(f.scope, material.snapshot, model, lateRows)).rejects.toThrow("invalid source embedding");
    expect(await f.sql`SELECT chunk_id FROM opening_source_embeddings WHERE source_id=${material.sourceId}`).toHaveLength(0);
    await expect(saveGraph(material)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await knowledge.get(f.scope, material.courseId)).toBeNull();
    // Readiness and recovery cannot treat old forbidden vectors as a usable index, even before cleanup.
    await f.sql`INSERT INTO opening_source_embeddings(chunk_id,source_id,source_version,model_key,dimensions,segment_index,text,embedding)
      VALUES(${chunkAt(material.snapshot, 4).id},${material.sourceId},0,${model.modelKey},3,0,'legacy restricted vector','[1,0,0]'::vector)`;
    expect(await embeddings.hasIndex(f.scope, { ...model, sourceIds: [material.sourceId] })).toBe(false);
    expect(await embeddings.listIndexedKeys(f.scope, material.snapshot, model)).toEqual([]);
    expect(await embeddings.search(f.scope, { ...model, sourceIds: [material.sourceId], vector: [1, 0, 0] })).toEqual([]);
  });

  it("preserves owner, version, course-membership and privacy boundaries", async () => {
    const material = await seedMaterial();
    const embeddings = createOpeningSourceEmbeddingsRepository(f.sql), knowledge = createOpeningKnowledgeRepository(f.sql);
    const forged = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
    expect(await embeddings.snapshot(forged, material.sourceId)).toBeNull();
    expect(await embeddings.snapshot(f.otherScope, material.sourceId)).toBeNull();
    expect(await embeddings.snapshot(f.scope, material.sourceId, 1)).toBeNull();
    await expect(knowledge.listAuthorizedChunks(forged, material.courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(knowledge.assertExtractionBatch(forged, material.courseId, [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${material.courseId}`;
    expect(await knowledge.listAuthorizedChunks(f.scope, material.courseId)).toEqual([]);
    await expect(knowledge.assertExtractionBatch(f.scope, material.courseId, material.snapshot.chunks)).rejects.toMatchObject({ code: "VALIDATION" });
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${material.sourceId})`;
    expect(await embeddings.snapshot(f.scope, material.sourceId)).toBeNull();
    await expect(embeddings.store(f.scope, material.snapshot, model, vectors(material.snapshot))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([false, true])("drives the real index handler with filtered model inputs and its live beforeSend guard (reclassified: %s)", async reclassified => {
    const material = await seedMaterial();
    await classify(material);
    const repository = createOpeningSourceEmbeddingsRepository(f.sql);
    const snapshot = (await repository.snapshot(f.scope, material.sourceId))!;
    const config: NonNullable<IndexSourceDeps["config"]> = { ...model, baseUrl: "https://unused.invalid/v1", modelName: "fixture",
      apiKey: "unused-test-key", inputCentsPerMillion: 1, billing: "metered", dailyRequestCap: null, requestDimensions: true };
    const submitted: string[] = [];
    const job: OpeningJobRecord = { ...f.scope, id: randomUUID(), key: "fixture-index", kind: "index-source", payload: {}, result: null,
      state: "running", privacyEpoch: snapshot.privacyEpoch };
    const handler = createIndexSourceHandler({ repository, config, budget: () => ({} as BudgetedRepository),
      embed: async input => {
        // Stop at the model boundary, not after a fake response: the send guard
        // must reject a classification committed after the worker took its snapshot.
        if (reclassified) await classify(material, { role: "answer_key", sections: [], questions: [], answers: [] }, 1);
        await input.beforeSend?.();
        submitted.push(...input.inputs);
        const result = { vectors: input.inputs.map(() => [1, 0, 0]), inputTokens: 0, requestId: "fixture-only" };
        await input.persistResult?.(result, { reservationId: "unused", settledCents: 0 });
        return result;
      },
    });
    const result = handler(job, { sourceId: material.sourceId, sourceVersion: 0 });
    if (reclassified) {
      await expect(result).rejects.toMatchObject({ code: "CONFLICT" });
      expect(submitted).toEqual([]);
      expect(await f.sql`SELECT chunk_id FROM opening_source_embeddings WHERE source_id=${material.sourceId}`).toEqual([]);
    } else {
      await expect(result).resolves.toMatchObject({ indexed: true, segments: 3 });
      expect(submitted).toEqual(snapshot.chunks.map(chunk => chunk.text));
      expect(await repository.listIndexedKeys(f.scope, snapshot, model)).toHaveLength(3);
    }
  });
});

describe("OPT03 material-derived invalidation", () => {
  it("downgrades only affected nodes and incident/evidence edges, purges private definitions/vectors, and revokes old CAS without rewriting facts", async () => {
    const material = await seedMaterial();
    const knowledge = createOpeningKnowledgeRepository(f.sql), embeddings = createOpeningSourceEmbeddingsRepository(f.sql);
    const learning = createOpeningLearningRepository(f.sql);
    const session = await learning.createSession(f.scope, { courseId: material.courseId, skillLabel: "functions", sourceIds: [material.sourceId] });
    const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, {
      sessionId: session.id, clientKey: randomUUID(), problem: { sourceId: material.sourceId,
        chunkId: chunkAt(material.snapshot, 4).id, physicalPage: 4, stemSnapshot: "Explain the domain", artifactKind: "reference_item" },
    });
    const observation = await learning.insertObservation(f.scope, { attemptId: attempt.id, sessionId: session.id,
      courseId: material.courseId, skillLabel: "functions", sourceIds: [material.sourceId], problemId: attempt.problemId,
      answer: "My original saved answer", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
    const savedAttempt = await f.sql`SELECT * FROM opening_learning_attempts WHERE id=${attempt.id}`;
    const savedObservation = await f.sql`SELECT * FROM opening_learning_observations WHERE id=${observation.id}`;
    const original = await saveGraph(material);
    const definitions = (await knowledge.getForRebuild(f.scope, material.courseId))!.nodeDefinitions;
    const [clean, exercise, answer, combined] = original.snapshot.nodes;
    expect(definitions[answer!.id]).toContain("SECRET ANSWER");
    expect(definitions[combined!.id]).toContain("SECRET ANSWER");
    await embeddings.store(f.scope, material.snapshot, model, vectors(material.snapshot));
    const facts = await sideEffects();
    const raw = await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${material.sourceId} ORDER BY id`;
    await classify(material);
    const downgraded = (await knowledge.getForRebuild(f.scope, material.courseId))!;
    expect(downgraded.version).toBe(original.version + 1);
    expect(downgraded.snapshot.version).toBe(downgraded.version);
    expect(downgraded.sourceVersions).toEqual(original.sourceVersions);
    expect(downgraded.snapshot.nodes).toEqual(original.snapshot.nodes.map((node, index) => index < 2 ? node : { ...node, status: "needs_check" }));
    expect(downgraded.snapshot.edges).toEqual(original.snapshot.edges.map((edge, index) => index === 0 ? edge : { ...edge, status: "needs_check" }));
    expect(downgraded.nodeDefinitions).toEqual({ [clean!.id]: definitions[clean!.id], [exercise!.id]: definitions[exercise!.id] });
    expect(await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${material.sourceId} ORDER BY id`).toEqual(raw);
    expect(await f.sql`SELECT * FROM opening_learning_attempts WHERE id=${attempt.id}`).toEqual(savedAttempt);
    expect(await f.sql`SELECT * FROM opening_learning_observations WHERE id=${observation.id}`).toEqual(savedObservation);
    expect(await sideEffects()).toEqual(facts);
    expect(ids((await embeddings.search(f.scope, { ...model, sourceIds: [material.sourceId], vector: [1, 0, 0] })).map(row => row.chunk)))
      .toEqual(ids(material.snapshot.chunks.filter(chunk => [1, 2, 3].includes(chunk.page!))));
    expect(await f.sql`SELECT e.chunk_id FROM opening_source_embeddings e JOIN opening_source_chunks c ON c.id=e.chunk_id
      WHERE e.source_id=${material.sourceId} AND c.page IN (4,6)`).toEqual([]);
    await expect(knowledge.replace(f.scope, material.courseId, { expectedVersion: original.version,
      snapshot: original.snapshot, sourceVersions: original.sourceVersions })).rejects.toMatchObject({ code: "CONFLICT" });
    // Idempotent cleanup, and relaxing classification never silently re-approves an old graph.
    await f.sql.begin(tx => invalidateMaterialDerived(tx, f.scope, material.sourceId, 0));
    expect(await knowledge.getForRebuild(f.scope, material.courseId)).toEqual(downgraded);
    await classify(material, unrestricted, 1);
    expect(await knowledge.getForRebuild(f.scope, material.courseId)).toEqual(downgraded);
    expect(await sideEffects()).toEqual(facts);
  }, 20_000);

  it("clears definitions even for already-needs-check nodes and conservatively handles missing evidence UUIDs", async () => {
    const material = await seedMaterial();
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const draft = graphFor(material);
    draft.nodes[2]!.status = "needs_check";
    const original = await knowledge.replace(f.scope, material.courseId, { expectedVersion: 0,
      snapshot: draft, sourceVersions: { [material.sourceId]: 0 } });
    const missingId = chunkAt(material.snapshot, 4).id;
    await f.sql`DELETE FROM opening_source_chunks WHERE id=${missingId}`;
    await f.sql.begin(tx => invalidateMaterialDerived(tx, f.scope, material.sourceId, 0));
    const current = (await knowledge.getForRebuild(f.scope, material.courseId))!;
    expect(current.version).toBe(original.version + 1);
    expect(current.nodeDefinitions).not.toHaveProperty(draft.nodes[2]!.id);
    expect(current.nodeDefinitions).not.toHaveProperty(draft.nodes[3]!.id);
    expect(current.snapshot.nodes.map(node => node.status)).toEqual(["supported", "supported", "needs_check", "needs_check", "supported"]);
    expect(current.snapshot.nodes[2]!.evidenceChunkIds).toEqual([missingId]);
  });

  it("isolates source versions, other courses, sources and owners", async () => {
    const old = await seedMaterial(), unrelated = await seedMaterial(), foreign = await seedMaterial(f.otherScope);
    const knowledge = createOpeningKnowledgeRepository(f.sql), embeddings = createOpeningSourceEmbeddingsRepository(f.sql);
    await saveGraph(old); await saveGraph(unrelated); await saveGraph(foreign);
    await embeddings.store(f.scope, old.snapshot, model, vectors(old.snapshot));
    await embeddings.store(f.scope, unrelated.snapshot, model, vectors(unrelated.snapshot));
    await embeddings.store(f.otherScope, foreign.snapshot, model, vectors(foreign.snapshot));
    const preserved = await Promise.all([knowledge.getForRebuild(f.scope, old.courseId), knowledge.getForRebuild(f.scope, unrelated.courseId),
      knowledge.getForRebuild(f.otherScope, foreign.courseId)]);
    const oldVectors = await f.sql`SELECT * FROM opening_source_embeddings WHERE source_id=${old.sourceId} ORDER BY chunk_id`;
    await f.sql`UPDATE opening_sources SET version=1,parse_state='running' WHERE id=${old.sourceId}`;
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${old.sourceId},1,${f.scope.workspaceId},512,${"cd".repeat(32)},'available')`;
    await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, { sourceId: old.sourceId, sourceVersion: 1,
      chunks: old.snapshot.chunks.map(chunk => ({ page: chunk.page, slideLabel: chunk.slideLabel, startMs: chunk.startMs,
        endMs: chunk.endMs, text: chunk.text, imageObjectKey: chunk.imageObjectKey })) });
    const current: Material = { ...old, courseId: await linkedCourse(f.scope, old.sourceId),
      snapshot: (await embeddings.snapshot(f.scope, old.sourceId))! };
    await saveGraph(current);
    await embeddings.store(f.scope, current.snapshot, model, vectors(current.snapshot));
    await classify(current);
    expect((await knowledge.getForRebuild(f.scope, current.courseId))!.snapshot.nodes[2]!.status).toBe("needs_check");
    expect(await Promise.all([knowledge.getForRebuild(f.scope, old.courseId), knowledge.getForRebuild(f.scope, unrelated.courseId),
      knowledge.getForRebuild(f.otherScope, foreign.courseId)])).toEqual(preserved);
    expect(await f.sql`SELECT * FROM opening_source_embeddings WHERE source_id=${old.sourceId} AND source_version=0 ORDER BY chunk_id`).toEqual(oldVectors);
    expect(await embeddings.listIndexedKeys(f.scope, unrelated.snapshot, model)).toHaveLength(vectors(unrelated.snapshot).length);
    expect(await embeddings.listIndexedKeys(f.otherScope, foreign.snapshot, model)).toHaveLength(vectors(foreign.snapshot).length);
  }, 20_000);

  it("rejects foreign scope/source/version and rolls back manifest, graph and vector changes together", async () => {
    const material = await seedMaterial();
    const knowledge = createOpeningKnowledgeRepository(f.sql), embeddings = createOpeningSourceEmbeddingsRepository(f.sql);
    await saveGraph(material);
    await embeddings.store(f.scope, material.snapshot, model, vectors(material.snapshot));
    const before = (await knowledge.getForRebuild(f.scope, material.courseId))!;
    const oldVectors = await f.sql`SELECT * FROM opening_source_embeddings WHERE source_id=${material.sourceId} ORDER BY chunk_id`;
    for (const [scope, version] of [[f.otherScope, 0], [{ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, 0], [f.scope, 1]] as const) {
      await expect(f.sql.begin(tx => invalidateMaterialDerived(tx, scope, material.sourceId, version))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const rollback = new Error("intentional rollback after derived invalidation");
    await expect(f.sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, f.scope);
      await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE`;
      await tx`UPDATE opening_source_versions SET material_manifest=${tx.json(mixed)} WHERE source_id=${material.sourceId} AND version=0`;
      await invalidateMaterialDerived(tx, f.scope, material.sourceId, 0);
      const [graph] = await tx`SELECT version FROM opening_course_knowledge WHERE course_id=${material.courseId}`;
      expect(Number(graph!.version)).toBe(before.version + 1);
      expect(await tx`SELECT e.chunk_id FROM opening_source_embeddings e JOIN opening_source_chunks c ON c.id=e.chunk_id
        WHERE e.source_id=${material.sourceId} AND c.page=4`).toEqual([]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await knowledge.getForRebuild(f.scope, material.courseId)).toEqual(before);
    expect(await f.sql`SELECT * FROM opening_source_embeddings WHERE source_id=${material.sourceId} ORDER BY chunk_id`).toEqual(oldVectors);
    const [version] = await f.sql`SELECT material_manifest FROM opening_source_versions WHERE source_id=${material.sourceId} AND version=0`;
    expect(version!.material_manifest).toBeNull();
  });

  it.each(["embedding", "knowledge"] as const)("serializes a late %s publication behind classification and rejects it after commit", async kind => {
    const material = await seedMaterial();
    const original = await saveGraph(material);
    const editor = openRaceSession(), writer = openRaceSession(), observer = openRaceSession();
    const pending: Promise<unknown>[] = [];
    let release!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    let failReady!: (error: unknown) => void;
    const edited = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
    try {
      await Promise.all([editor.ready, writer.ready, observer.ready]);
      const editing = track(editor.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, f.scope);
        await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE`;
        await tx`UPDATE opening_source_versions SET material_manifest=${tx.json(mixed)} WHERE source_id=${material.sourceId} AND version=0`;
        await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
        await invalidateMaterialDerived(tx, f.scope, material.sourceId, 0);
        ready();
        await resume;
      }));
      pending.push(editing);
      void editing.catch(failReady);
      await edited;
      const publication = track<unknown>(kind === "embedding"
        ? createOpeningSourceEmbeddingsRepository(writer.sql).store(f.scope, material.snapshot, model, vectors(material.snapshot))
        : createOpeningKnowledgeRepository(writer.sql).replace(f.scope, material.courseId, { expectedVersion: original.version,
          snapshot: original.snapshot, sourceVersions: original.sourceVersions }));
      pending.push(publication);
      await waitUntilBlocked(observer.sql, writer.pid, editor.pid, "late material publication", /FROM workspaces[\s\S]*FOR (SHARE|UPDATE)/i);
      release();
      await editing;
      await expect(publication).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await f.sql`SELECT chunk_id FROM opening_source_embeddings WHERE source_id=${material.sourceId}`).toEqual([]);
      expect((await createOpeningKnowledgeRepository(f.sql).get(f.scope, material.courseId))!.snapshot.nodes[2]!.status).toBe("needs_check");
    } finally {
      release();
      await awaitAllSettled(pending);
      await Promise.all([closeRace(editor.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  }, 25_000);
});
