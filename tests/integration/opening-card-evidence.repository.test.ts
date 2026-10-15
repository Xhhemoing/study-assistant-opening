import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createBackupRestoreRepository, createCardRepository, createOpeningLearningRepository } from "@aistudy/database";
import { summarizeObservations } from "@aistudy/domain";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { readOpeningBackupRecords, OPENING_BACKUP_TABLES } from "../../packages/database/src/repositories/opening-backup-records";
import { executeOpeningRestoreApply } from "../../packages/database/src/repositories/opening-backup-apply";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE learning_events,card_review_states,cards,opening_learning_observations RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await fixture?.close(); });
async function course(workspaceId = fixture.scope.workspaceId) {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${workspaceId},'Card course',${id})`;
  return id;
}
function create(courseId?: string) {
  return createCardRepository(fixture.sql).createCard({ ...fixture.scope, front: "What is a derivative?", back: "A limit.", courseId, skillLabel: courseId ? "derivatives" : null });
}
function grade(cardId: string, value: "again" | "hard" | "good" | "easy", idempotencyKey = randomUUID()) {
  return createCardRepository(fixture.sql).grade({ ...fixture.scope, cardId, grade: value, idempotencyKey, occurredAt: new Date().toISOString() });
}

it.each(["again", "hard", "good", "easy"] as const)("records %s as self-report evidence in the same review transaction and replays once", async value => {
  const courseId = await course(), card = await create(courseId), key = randomUUID();
  const result = await grade(card.id, value, key);
  const replay = await grade(card.id, value, key);
  expect(replay).toMatchObject({ created: false, event: { id: result.event.id } });
  const rows = await fixture.sql`SELECT * FROM opening_learning_observations WHERE client_key=${`card-review:${result.event.id}`}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ course_id: courseId, skill_label: "derivatives", outcome: value === "again" ? "incorrect" : "correct", assistance: "independent", verdict_source: "self_report" });
  const observations = await createOpeningLearningRepository(fixture.sql).listObservationsForCourse(fixture.scope, courseId);
  const contexts = Object.fromEntries(await Promise.all(observations.map(async row => [row.id, await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, row)])));
  expect(summarizeObservations(observations, new Date().toISOString(), { evidenceContexts: contexts })[0]?.status).toBe("needs_check");
  expect(contexts[observations[0]!.id]!.observation.verdictSource).toBe("self_report");
});

it("keeps unlinked cards in SRS only", async () => {
  const card = await create();
  const result = await grade(card.id, "good");
  expect(result.state.reps).toBe(1);
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});

it("rejects foreign/archived courses and rolls back an entire review if its course becomes unavailable", async () => {
  await expect(create(await course(fixture.otherScope.workspaceId))).rejects.toMatchObject({ code: "NOT_FOUND" });
  const courseId = await course(), card = await create(courseId);
  await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
  await expect(create(courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(grade(card.id, "good")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await fixture.sql`SELECT id FROM learning_events WHERE content_id=${card.id}`).toHaveLength(0);
  expect(await createCardRepository(fixture.sql).getState({ ...fixture.scope, cardId: card.id })).toMatchObject({ reps: 0 });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
});

it("round-trips independent cards, course attribution, SRS state, and review idempotency in Opening backup", async () => {
  const courseId = await course(), card = await create(courseId), key = randomUUID();
  const first = await grade(card.id, "hard", key);
  const noteId = randomUUID();
  await fixture.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number) VALUES(${noteId},${fixture.scope.workspaceId},'Native card note','scratch',1,0)`;
  await createCardRepository(fixture.sql).createCard({ ...fixture.scope, front: "From note", back: "Native backup only", sourceDocumentId: noteId, courseId, skillLabel: "notes" });
  const snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(snapshot.tables.cards).toHaveLength(1);
  expect(snapshot.tables.cards[0]).toMatchObject({ id: card.id, course_id: courseId, skill_label: "derivatives" });
  const backup = { format: "opening-backup" as const, version: 1 as const, workspaceId: fixture.scope.workspaceId, privacyEpoch: snapshot.privacyEpoch, deletionJournal: snapshot.deletionJournal,
    memoryDeletions: snapshot.memoryDeletions, tables: snapshot.tables, objects: [] };
  await fixture.sql`TRUNCATE ${fixture.sql([...OPENING_BACKUP_TABLES])} CASCADE`;
  const result = await executeOpeningRestoreApply(fixture.sql, { confirmLocalRestore: true, backup,
    currentLearningState: { workspacePreferences: null, courses: [] }, currentMemoryDeletions: snapshot.memoryDeletions });
  expect(result).toMatchObject({ ok: true, code: "APPLY_OK" });
  expect(await createCardRepository(fixture.sql).getCard({ workspaceId: fixture.scope.workspaceId, cardId: card.id })).toMatchObject({ courseId, skillLabel: "derivatives" });
  expect(await grade(card.id, "hard", key)).toMatchObject({ created: false, event: { id: first.event.id }, state: { reps: 1 } });
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE client_key=${`card-review:${first.event.id}`}`).toHaveLength(1);
});

it("preserves course and skill columns in native card restore", async () => {
  const courseId = await course(), card = await create(courseId);
  const repository = createBackupRestoreRepository(fixture.sql);
  const packed = await repository.exportWorkspace(fixture.scope);
  await fixture.sql`DELETE FROM cards WHERE id=${card.id}`;
  await fixture.sql`DELETE FROM courses WHERE id=${courseId}`;
  await repository.restoreWorkspace({ ...fixture.scope, packed, conflictPolicy: "skip" });
  expect(await createCardRepository(fixture.sql).getCard({ workspaceId: fixture.scope.workspaceId, cardId: card.id })).toMatchObject({ courseId, skillLabel: "derivatives" });
});
