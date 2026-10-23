import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createCardRepository, createOpeningAiGradingRepository, createBackupRestoreRepository } from "@aistudy/database";
import { createInitialState, scheduleReview } from "@aistudy/domain";
import { matrixAttemptFixture } from "./opening-matrix-attempt-fixture";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, type AiGradingProposal } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { syncOpeningAutomaticErrorCard } from "../../packages/database/src/repositories/opening-auto-error-cards";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { await f.reset(); await f.sql`TRUNCATE cards,opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await f?.close(); });
const proposal: AiGradingProposal = { outcome: "incorrect", confidence: 0.95, questionMatch: true,
  feedback: "同分母只加分子：1/2 + 1/2 = 1。", criteria: [{ label: "同分母相加", verdict: "incorrect", feedback: "分母保持2，分子1+1，再约分。" }] };
const now = new Date("2026-10-21T08:00:00.000Z");
it("persists FSRS, uses Opening exam goal, and safely replays the review key", async () => {
  const setup = await learningAttemptFixture(f), cards = createCardRepository(f.sql);
  const card = await cards.createCard({ ...f.scope, courseId: setup.courseId, front: "Q", back: "A" });
  const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [setup.courseId]: { targetDate: "2026-10-23", weeklyMinutes: 420, learningMode: "exam" } } };
  await f.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${f.scope.workspaceId},${f.sql.json(prefs)})
    ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning`;
  const input = { ...f.scope, cardId: card.id, grade: "easy" as const, idempotencyKey: randomUUID(), occurredAt: now.toISOString(), now };
  const first = await cards.grade(input), replay = await cards.grade(input);
  expect(first.state).toMatchObject({ srsVersion: "fsrs-5.4.2", reps: 1, dueAt: "2026-10-22T00:00:00.000Z", fsrs: { state: 2, reps: 1, scheduledDays: 8 } });
  expect(replay.created).toBe(false);
  expect(replay.state).toEqual(first.state);
  expect((await cards.getState({ ...f.scope, cardId: card.id }))?.fsrs).toEqual(first.state.fsrs);
  expect(await cards.getState({ ...f.otherScope, cardId: card.id })).toBeNull();
  await expect(cards.grade({ ...input, ...f.otherScope, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("leaves legacy due unchanged until real review and replays only complete histories", async () => {
  const cards = createCardRepository(f.sql), card = await cards.createCard({ ...f.scope, front: "Q", back: "A" });
  for (const occurredAt of ["2026-10-01T08:00:00Z", "2026-10-09T08:00:00Z"]) {
    await cards.grade({ ...f.scope, cardId: card.id, grade: "easy", idempotencyKey: randomUUID(), occurredAt });
  }
  await f.sql`UPDATE card_review_states SET srs_version='srs-1',fsrs_state=NULL,due_at='2027-01-01T00:00:00Z' WHERE card_id=${card.id}`;
  expect((await cards.getState({ ...f.scope, cardId: card.id }))?.dueAt).toBe("2027-01-01T00:00:00.000Z");
  const next = await cards.grade({ ...f.scope, cardId: card.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: now.toISOString() });
  expect(next.state.fsrs?.reps).toBe(3);
  expect(next.state.reps).toBe(3);
  const orphan = await cards.createCard({ ...f.scope, front: "old", back: "old" });
  await f.sql`UPDATE card_review_states SET srs_version='srs-1',fsrs_state=NULL,reps=9,ease=1.3,due_at='2027-02-01T00:00:00Z' WHERE card_id=${orphan.id}`;
  expect((await cards.getState({ ...f.scope, cardId: orphan.id }))?.dueAt).toBe("2027-02-01T00:00:00.000Z");
  const reset = await cards.grade({ ...f.scope, cardId: orphan.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: now.toISOString() });
  expect(reset.state.fsrs?.reps).toBe(1);
  expect(reset.state.reps).toBe(10);
});
it("creates one source-linked error card, suspends it on correction/retraction and preserves manual cards and reviews", async () => {
  const setup = await learningAttemptFixture(f), cards = createCardRepository(f.sql);
  const original = await setup.submit(await setup.start(), { outcome: "unverified", answer: "WRONG_STUDENT_ANSWER" });
  const grading = createOpeningAiGradingRepository(f.sql);
  const graded = await grading.apply(f.scope, { observationId: original.id }, proposal, "test");
  await grading.apply(f.scope, { observationId: original.id }, proposal, "test");
  const list = await cards.listCards(f.scope);
  expect(list).toHaveLength(1);
  const auto = list[0]!;
  expect(auto).toMatchObject({ front: "1/2 + 1/2?", originObservationRootId: original.id, autoPaused: false, courseId: setup.courseId });
  expect(auto.back).toContain("1/2 + 1/2 = 1");
  expect(auto.back).not.toContain("WRONG_STUDENT_ANSWER");
  const [raw] = await f.sql`SELECT source_ids FROM cards WHERE id=${auto.id}`;
  expect(raw!.source_ids).toEqual([setup.sourceId]);
  const manual = await cards.createCard({ ...f.scope, observationId: graded.id, front: "My note", back: "My answer", courseId: setup.courseId });
  await expect(cards.grade({ ...f.scope, cardId: auto.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: now.toISOString() })).rejects.toMatchObject({ code: "CONFLICT" });
  // Seed a historical review to verify correction preserves scheduling history.
  await cards.upsertState({ ...f.scope, state: scheduleReview(createInitialState(auto.id, now), "good", now) });
  const corrected = await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: original.id, revisesObservationId: graded.id,
    expectedHead: graded.id, revisionKind: "replace", reason: "判错了", clientKey: randomUUID(), replacement: { answer: graded.answer, outcome: "correct", assistance: graded.assistance } });
  expect((await cards.getCard({ workspaceId: f.scope.workspaceId, cardId: auto.id })).autoPaused).toBe(true);
  expect((await cards.getCard({ workspaceId: f.scope.workspaceId, cardId: manual.id })).autoPaused).toBe(false);
  expect((await cards.getState({ ...f.scope, cardId: auto.id }))?.reps).toBe(1);
  expect((await cards.listQueue({ ...f.scope, mode: "free" })).map(row => row.card.id)).toEqual([manual.id]);
  await expect(cards.grade({ ...f.scope, cardId: auto.id, grade: "good", idempotencyKey: randomUUID(), occurredAt: now.toISOString() })).rejects.toMatchObject({ code: "CONFLICT" });
  const regraded = await grading.apply(f.scope, { observationId: corrected.headObservationId }, proposal, "test");
  expect((await cards.listCards(f.scope))).toHaveLength(2);
  expect((await cards.getCard({ workspaceId: f.scope.workspaceId, cardId: auto.id })).autoPaused).toBe(false);
  await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: original.id, revisesObservationId: regraded.id, expectedHead: regraded.id,
    revisionKind: "retract", reason: "删除这次记录", clientKey: randomUUID() });
  expect((await cards.getCard({ workspaceId: f.scope.workspaceId, cardId: auto.id })).autoPaused).toBe(true);
  expect((await cards.getState({ ...f.scope, cardId: auto.id }))?.reps).toBe(1);
  await f.sql.begin(tx => syncOpeningAutomaticErrorCard(tx, f.otherScope, regraded.id));
  expect(await cards.listCards(f.otherScope)).toEqual([]);
});
it("uncertain AI feedback never manufactures an automatic card", async () => {
  const setup = await learningAttemptFixture(f), original = await setup.submit(await setup.start(), { outcome: "unverified" });
  await createOpeningAiGradingRepository(f.sql).apply(f.scope, { observationId: original.id }, { ...proposal, confidence: 0.4 }, "test");
  expect(await createCardRepository(f.sql).listCards(f.scope)).toEqual([]);
});

it("creates a deterministic mistake card from the canonical answer, not the wrong matrix response", async () => {
  const setup = await matrixAttemptFixture(f);
  const observation = await setup.submit(await setup.start(), { answer: "[3,2]" });
  const [card] = await createCardRepository(f.sql).listCards(f.scope);
  expect(card).toMatchObject({ originObservationRootId: observation.id, autoPaused: false });
  expect(card!.back).toContain("答案：[2,3]"); expect(card!.back).not.toContain("[3,2]");
});
it("round-trips complete FSRS state in native backup and rejects malformed memory before restoring", async () => {
  const isolated = await createOpeningFixture();
  try {
    const cards = createCardRepository(isolated.sql), backups = createBackupRestoreRepository(isolated.sql);
    const card = await cards.createCard({ ...isolated.scope, front: "Independent question", back: "Reference" });
    const state = scheduleReview(createInitialState(card.id, now), "easy", now);
    await cards.upsertState({ ...isolated.scope, state });
    const packed = await backups.exportWorkspace(isolated.scope);
    await isolated.sql`DELETE FROM cards WHERE id=${card.id}`;
    const invalid = structuredClone(packed);
    (invalid.records.cards[0]!.reviewStates as Array<Record<string, unknown>>)[0]!.fsrsState = {};
    await expect(backups.restoreWorkspace({ ...isolated.scope, packed: invalid, conflictPolicy: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    await backups.restoreWorkspace({ ...isolated.scope, packed, conflictPolicy: "reject" });
    expect(await cards.getState({ ...isolated.scope, cardId: card.id })).toMatchObject(state);
  } finally { await isolated.close(); }
});
