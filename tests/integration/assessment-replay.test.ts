import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createLearningEventRepository,
  createSqlClient,
  LearningEventRepositoryError,
  type IdentityRepository,
  type LearningEventRepository,
} from "@aistudy/database";
import {
  ASSESSMENT_MODEL_VERSION,
  ASSESSMENT_VERSION,
  correctionFromLearningEvent,
  deriveStatus,
  evidenceFromLearningEvent,
  type EvidenceEvent,
  type StatusCorrection,
} from "@aistudy/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for assessment replay tests");
}

const now = new Date("2026-08-15T12:00:00.000Z");
const occurredAt = "2026-08-14T10:00:00.000Z";

describe("assessment replay from persisted learning events", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let events: LearningEventRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let otherWorkspaceId: string;
  const contentId = randomUUID();
  const syllabusPointId = randomUUID();

  beforeAll(async () => {
    await applyMigrations(sql);
    identity = createIdentityRepository(sql);
    events = createLearningEventRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_events, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    const owner = await identity.createUserWithWorkspace({
      email: `assess-a-${randomUUID()}@example.com`,
      displayName: "Assessment owner",
      passwordHash: "scrypt$not-used",
    });
    const other = await identity.createUserWithWorkspace({
      email: `assess-b-${randomUUID()}@example.com`,
      displayName: "Other owner",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    otherWorkspaceId = other.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("recomputes the same status and snapshot from stored events", async () => {
    const firstAttempt = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "assess-replay-attempt-01",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 4,
        errorCause: null,
        abilitySlice: "recall",
      },
    });
    const review = await events.append({
      workspaceId,
      ownerUserId,
      type: "review",
      idempotencyKey: "assess-replay-review-01",
      occurredAt: "2026-08-14T11:00:00.000Z",
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    });
    const excluded = await events.append({
      workspaceId,
      ownerUserId,
      type: "review",
      idempotencyKey: "assess-replay-review-02",
      occurredAt: "2026-08-14T12:00:00.000Z",
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: { grade: "again", assisted: false, excludeFromAssessment: true },
    });

    const loaded = [
      await events.get({ workspaceId, eventId: firstAttempt.id }),
      await events.get({ workspaceId, eventId: review.id }),
      await events.get({ workspaceId, eventId: excluded.id }),
    ];
    const evidence = loaded
      .map(evidenceFromLearningEvent)
      .filter((item): item is EvidenceEvent => item !== null);
    const first = deriveStatus(syllabusPointId, evidence, now);
    const second = deriveStatus(syllabusPointId, evidence, now);

    expect(evidence).toHaveLength(2);
    expect(first).toEqual(second);
    expect(first.status).toBe("usable");
    expect(first.evidenceSnapshotId).toBe(second.evidenceSnapshotId);
    expect(first.strategyVersion).toBe(ASSESSMENT_VERSION);
    expect(first.modelVersion).toBe(ASSESSMENT_MODEL_VERSION);
  });

  it("replays a persisted status correction onto the derived band", async () => {
    const attempt = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "assess-replay-attempt-03",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "A",
        correct: false,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 2,
        errorCause: "concept",
        abilitySlice: "recall",
      },
    });
    const storedCorrection = await events.append({
      workspaceId,
      ownerUserId,
      type: "correction",
      idempotencyKey: "assess-replay-correction-01",
      occurredAt: "2026-08-14T11:00:00.000Z",
      correctsEventId: attempt.id,
      syllabusPointId,
      payload: { kind: "status", note: "应为稳固", overrideStatus: "stable" },
    });
    const loadedAttempt = await events.get({ workspaceId, eventId: attempt.id });
    const loadedCorrection = await events.get({ workspaceId, eventId: storedCorrection.id });
    const evidence = [loadedAttempt]
      .map(evidenceFromLearningEvent)
      .filter((item): item is EvidenceEvent => item !== null);
    const corrections = [correctionFromLearningEvent(loadedCorrection)].filter(
      (item): item is StatusCorrection => item !== null,
    );
    const result = deriveStatus(syllabusPointId, evidence, now, corrections);
    expect(result.status).toBe("stable");
    expect(result.reasonCodes[0]).toBe("user-correction");
  });

  it("lists owner events in occurred_at, created_at, id order and isolates workspaces", async () => {
    const laterPoint = randomUUID();
    const first = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "assess-list-attempt-02",
      occurredAt: "2026-08-14T12:00:00.000Z",
      contentId,
      contentVersion: 1,
      syllabusPointId: laterPoint,
      payload: {
        answer: "B",
        correct: true,
        assisted: false,
        durationMs: 3000,
        hintCount: 0,
        confidence: 3,
        errorCause: null,
        abilitySlice: "recall",
      },
    });
    const second = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "assess-list-attempt-01",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 4,
        errorCause: null,
        abilitySlice: "recall",
      },
    });
    const otherOwner = await identity.createUserWithWorkspace({
      email: `assess-c-${randomUUID()}@example.com`,
      displayName: "Third owner",
      passwordHash: "scrypt$not-used",
    });
    await events.append({
      workspaceId: otherOwner.workspace.id,
      ownerUserId: otherOwner.user.id,
      type: "attempt",
      idempotencyKey: "assess-list-other-01",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "C",
        correct: false,
        assisted: false,
        durationMs: 1000,
        hintCount: 0,
        confidence: 1,
        errorCause: null,
        abilitySlice: "recall",
      },
    });
    const listed = await events.listForOwner({ workspaceId, ownerUserId });
    const expected = [...listed].sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1;
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });
    expect(listed.map((event) => event.id)).toEqual(expected.map((event) => event.id));
    expect(listed.every((event) => event.workspaceId === workspaceId && event.ownerUserId === ownerUserId)).toBe(true);
    expect(listed.map((event) => event.id)).toEqual([second.id, first.id]);
    const filtered = await events.listForOwner({ workspaceId, ownerUserId, syllabusPointId });
    expect(filtered.map((event) => event.id)).toEqual([second.id]);
  });

  it("rejects loading another workspace's events for replay", async () => {
    const created = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "assess-replay-attempt-02",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 4,
        errorCause: null,
        abilitySlice: "procedure",
      },
    });

    await expect(events.get({ workspaceId: otherWorkspaceId, eventId: created.id })).rejects.toBeInstanceOf(
      LearningEventRepositoryError,
    );
    await expect(events.get({ workspaceId: otherWorkspaceId, eventId: created.id })).rejects.toMatchObject({
      code: "WORKSPACE_MISMATCH",
    });
  });
});
