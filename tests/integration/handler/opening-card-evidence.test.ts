import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createSessionJwt } from "../../../apps/web/src/lib/session";
import { createBackupRestoreRepository, createCardRepository, hashSessionToken, createOpeningLearningRepository } from "@aistudy/database";
import { createOpeningLearningAttemptRepository } from "../../../packages/database/src/repositories/opening-learning-attempts";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as createCard } from "../../../apps/web/src/app/api/cards/route";
import { GET as observationHistory } from "../../../apps/web/src/app/api/opening/observations/[id]/history/route";
import { createOpeningPrivacyRepository } from "../../../packages/database/src/repositories/opening-privacy";
import { GET as cardDraft } from "../../../apps/web/src/app/api/opening/observations/[id]/card-draft/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { readOpeningBackupRecords } from "../../../packages/database/src/repositories/opening-backup-records";
import { executeOpeningRestoreApply } from "../../../packages/database/src/repositories/opening-backup-apply";
import { backupRows } from "../opening-backup-records-fixture";
let otherCookie: string;
let fixture: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", authCookieName: "aistudy_session", sessionCookieSecure: false, sessionTtlSeconds: 3600 });
  setAuthRuntimeForTests(runtime);
  const sid = randomUUID();
  const token = await createSessionJwt({ sub: fixture.otherScope.ownerUserId, workspaceId: fixture.otherScope.workspaceId, sid }, process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", 3600);
  await fixture.sql`INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(${sid},${fixture.otherScope.ownerUserId},${hashSessionToken(token)},now()+interval '1 hour')`;
  otherCookie = `aistudy_session=${token}`;
});
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });
function request(body?: unknown, cookie = fixture.cookie) {
  return new Request("http://localhost/api/cards", { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
async function seed(outcome: "incorrect" | "correct" = "incorrect", reference = true) {
  const scope = fixture.scope, courseId = randomUUID(), rows = backupRows(fixture.sql, scope);
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Card course',${courseId})`;
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  const referenceSourceId = await rows.source();
  await rows.chunk(referenceSourceId);
  await fixture.sql`UPDATE opening_source_chunks SET text='A trusted reference answer' WHERE source_id=${referenceSourceId}`;
  const repo = createOpeningLearningRepository(fixture.sql);
  const session = await repo.createSession(scope, { courseId, skillLabel: "derivatives", sourceIds: [sourceId, referenceSourceId] });
  const attempt = await createOpeningLearningAttemptRepository(fixture.sql).create(scope, { sessionId: session.id, clientKey: randomUUID(), problem: { sourceId, chunkId, stemSnapshot: "What is a derivative?", artifactKind: "reference_item" } });
  const observation = await repo.insertObservation(scope, { sessionId: session.id, attemptId: attempt.id, courseId, skillLabel: "derivatives", sourceIds: [sourceId, referenceSourceId], clientKey: randomUUID(), answer: "Wrong student answer", outcome, assistance: "independent", ...(reference ? { verdictSource: "reference_checked" as const, referenceSourceId, referenceCheck: { referenceSourceId, method: "learner_self_compare", scope: "whole_answer" as const } } : {}) });
  return { observation, sourceId, referenceSourceId, courseId };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
it("prefills question, reference, course and skill only for an owned submitted incorrect record", async () => {
  const { observation, courseId, referenceSourceId } = await seed();
  expect((await cardDraft(request(undefined, ""), params(observation.id))).status).toBe(401);
  const response = await cardDraft(request(), params(observation.id));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ observationId: observation.id, front: "What is a derivative?", back: "A trusted reference answer", courseId, skillLabel: "derivatives" });
  expect((await cardDraft(request(undefined, otherCookie), params(observation.id))).status).toBe(404);
  expect((await cardDraft(request(), params(randomUUID()))).status).toBe(404);
  await backupRows(fixture.sql, fixture.scope).exclude(referenceSourceId);
  expect((await cardDraft(request(), params(observation.id))).status).toBe(404);
});
it("never prefills an incorrect student's answer as a reference and rejects correct records", async () => {
  const { observation } = await seed("incorrect", false);
  expect(await (await cardDraft(request(), params(observation.id))).json()).toMatchObject({ back: "" });
  const correct = await seed("correct");
  expect((await cardDraft(request(), params(correct.observation.id))).status).toBe(409);
});
it("creates course-attributed cards and refuses foreign or archived courses", async () => {
  const { courseId } = await seed();
  const body = { cardId: randomUUID(), front: "Q", back: "A", courseId, skillLabel: "derivatives" };
  const response = await createCard(request(body));
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ card: { courseId, skillLabel: "derivatives" } });
  const foreignCourse = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${foreignCourse},${fixture.otherScope.workspaceId},'Foreign',${foreignCourse})`;
  expect((await createCard(request({ ...body, cardId: randomUUID(), courseId: foreignCourse }))).status).toBe(404);
  await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
  expect((await createCard(request({ ...body, cardId: randomUUID() }))).status).toBe(404);
});

it("preserves server-owned lineage through review and rejects reads/exports/restores after exclusion", async () => {
  const { observation, courseId, sourceId, referenceSourceId } = await seed();
  const response = await createCard(request({ front: "Private derived question", back: "Private reference", courseId, skillLabel: "derivatives", observationId: observation.id, sourceIds: [randomUUID()] }));
  expect(response.status).toBe(201);
  const { card } = await response.json();
  const [stored] = await fixture.sql`SELECT source_ids FROM cards WHERE id=${card.id}`;
  expect(stored?.source_ids.sort()).toEqual([sourceId, referenceSourceId].sort());
  const cards = createCardRepository(fixture.sql);
  const review = await cards.grade({ ...fixture.scope, cardId: card.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: new Date().toISOString() });
  const [fact] = await fixture.sql`SELECT id,source_ids FROM opening_learning_observations WHERE client_key=${`card-review:${review.event.id}`}`;
  expect(fact?.source_ids.sort()).toEqual([sourceId, referenceSourceId].sort());
  const native = createBackupRestoreRepository(fixture.sql), packed = await native.exportWorkspace(fixture.scope);
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  await backupRows(fixture.sql, fixture.scope).exclude(sourceId);
  await expect(cards.getCard({ workspaceId: fixture.scope.workspaceId, cardId: card.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await cards.listCards(fixture.scope)).some(row => row.id === card.id)).toBe(false);
  expect((await cards.listQueue({ ...fixture.scope, mode: "free" })).some(row => row.card.id === card.id)).toBe(false);
  await expect(cards.grade({ ...fixture.scope, cardId: card.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: new Date().toISOString() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const opening = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(JSON.stringify(opening)).not.toContain("Private derived question");
  expect((await observationHistory(request(), params(String(fact!.id)))).status).toBe(404);
  expect(JSON.stringify(await native.exportWorkspace(fixture.scope))).not.toContain("Private derived question");
  await expect(native.restoreWorkspace({ ...fixture.scope, packed, conflictPolicy: "skip" })).rejects.toMatchObject({ code: "VALIDATION" });
  const marker = [{ sourceId, deletedAt: opening.deletionJournal.find(row => row.sourceId === sourceId)!.deletedAt }];
  const restored = await executeOpeningRestoreApply(fixture.sql, { confirmLocalRestore: true, backup: { format: "opening-backup", version: 1, workspaceId: fixture.scope.workspaceId,
    privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal, memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] },
    currentDeletionJournal: marker, currentMemoryDeletions: opening.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
  expect(restored.ok).toBe(false);
});
it("refuses foreign observation lineage and foreign source notes", async () => {
  const { observation, courseId } = await seed();
  const body = { front: "Q", back: "A", observationId: observation.id, courseId };
  expect((await createCard(request(body, otherCookie))).status).toBe(404);
  const noteId = randomUUID();
  await fixture.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number) VALUES(${noteId},${fixture.otherScope.workspaceId},'Foreign note','scratch',1,0)`;
  expect((await createCard(request({ front: "Q", back: "A", sourceDocumentId: noteId }))).status).toBe(404);
});

it("keeps legacy note lineage on new review facts and hides it after physical source removal", async () => {
  const { sourceId, courseId } = await seed();
  const noteId = randomUUID();
  await fixture.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number) VALUES(${noteId},${fixture.scope.workspaceId},'Private source note','scratch',1,0)`;
  await fixture.sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
    VALUES(${noteId},${fixture.scope.workspaceId},${fixture.sql.json([{ sourceId, sourceVersion: 1 }])})`;
  const cards = createCardRepository(fixture.sql);
  const card = await cards.createCard({ ...fixture.scope, front: "Legacy note private question", back: "Reference", sourceDocumentId: noteId, courseId });
  // Simulate a pre-0064 source-note card: lineage originally lived only on its note.
  await fixture.sql`UPDATE cards SET source_ids='{}' WHERE id=${card.id}`;
  const review = await cards.grade({ ...fixture.scope, cardId: card.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: new Date().toISOString() });
  const [fact] = await fixture.sql`SELECT source_ids FROM opening_learning_observations WHERE client_key=${`card-review:${review.event.id}`}`;
  expect(fact?.source_ids).toEqual([sourceId]);
  await fixture.sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
  await expect(cards.getCard({ workspaceId: fixture.scope.workspaceId, cardId: card.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await cards.listCards(fixture.scope)).some(row => row.id === card.id)).toBe(false);
  expect(JSON.stringify(await createBackupRestoreRepository(fixture.sql).exportWorkspace(fixture.scope))).not.toContain("Legacy note private question");
});
it("rejects native archives with a foreign course or forged foreign source lineage", async () => {
  const { observation, courseId } = await seed();
  const response = await createCard(request({ front: "Q", back: "A", courseId, observationId: observation.id }));
  expect(response.status).toBe(201);
  const repository = createBackupRestoreRepository(fixture.sql), packed = await repository.exportWorkspace(fixture.scope);
  const foreignCourse = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${foreignCourse},${fixture.otherScope.workspaceId},'Foreign',${foreignCourse})`;
  const altered = structuredClone(packed);
  altered.records.cards = [{ ...altered.records.cards[0], id: randomUUID(), courseId: foreignCourse }];
  await expect(repository.restoreWorkspace({ ...fixture.scope, packed: altered, conflictPolicy: "skip" })).rejects.toMatchObject({ code: "VALIDATION" });
  const foreignSource = await backupRows(fixture.sql, fixture.otherScope).source();
  altered.records.cards = [{ ...altered.records.cards[0], id: randomUUID(), courseId, sourceIds: [foreignSource] }];
  await expect(repository.restoreWorkspace({ ...fixture.scope, packed: altered, conflictPolicy: "skip" })).rejects.toMatchObject({ code: "VALIDATION" });
});
it("serializes grade and exclusion in workspace-history order without deadlock", async () => {
  const { observation, courseId, sourceId } = await seed();
  const response = await createCard(request({ front: "Concurrent private question", back: "A", courseId, observationId: observation.id }));
  const { card } = await response.json(), cards = createCardRepository(fixture.sql);
  const results = await Promise.allSettled([
    cards.grade({ ...fixture.scope, cardId: card.id, grade: "hard", idempotencyKey: randomUUID(), occurredAt: new Date().toISOString() }),
    createOpeningPrivacyRepository(fixture.sql).recordExclusions(fixture.sql, fixture.scope, { sourceIds: [sourceId], memoryId: randomUUID(), deletedAt: new Date() }),
  ]);
  expect(results[1].status).toBe("fulfilled");
  if (results[0].status === "rejected") expect(results[0].reason).toMatchObject({ code: "NOT_FOUND" });
  expect(JSON.stringify(await readOpeningBackupRecords(fixture.sql, fixture.scope))).not.toContain("Concurrent private question");
});
