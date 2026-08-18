import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createLearningEventRepository,
  createSqlClient,
  type IdentityRepository,
  type LearningEventRepository,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for learning event repository tests");
}

const occurredAt = "2026-08-15T03:00:00.000Z";
const attemptPayload = {
  answer: "A",
  correct: false,
  assisted: false,
  durationMs: 14000,
  hintCount: 1,
  confidence: 2,
  errorCause: "concept" as const,
  abilitySlice: "procedure" as const,
};

describe("learning event repository", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let events: LearningEventRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let otherWorkspaceId: string;
  let otherUserId: string;
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
      email: `events-a-${randomUUID()}@example.com`,
      displayName: "Event owner",
      passwordHash: "scrypt$not-used",
    });
    const other = await identity.createUserWithWorkspace({
      email: `events-b-${randomUUID()}@example.com`,
      displayName: "Other owner",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    otherWorkspaceId = other.workspace.id;
    otherUserId = other.user.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("appends an attempt and keeps the content version on retry", async () => {
    const first = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-01",
      occurredAt,
      contentId,
      contentVersion: 3,
      syllabusPointId,
      payload: attemptPayload,
    });
    const retried = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-01",
      occurredAt: "2026-08-15T04:00:00.000Z",
      contentId,
      contentVersion: 9,
      syllabusPointId,
      payload: { ...attemptPayload, answer: "B", correct: true },
    });
    const rows = await sql`SELECT count(*)::int AS count FROM learning_events`;

    expect(first.contentVersion).toBe(3);
    expect(retried).toEqual(first);
    expect(retried.payload).toEqual(attemptPayload);
    expect(rows[0]?.count).toBe(1);
  });

  it("appends a correction without mutating the original payload", async () => {
    const original = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-02",
      occurredAt,
      contentId,
      contentVersion: 3,
      syllabusPointId,
      payload: attemptPayload,
    });
    const correction = await events.append({
      workspaceId,
      ownerUserId,
      type: "correction",
      idempotencyKey: "correct-key-01",
      occurredAt: "2026-08-15T03:05:00.000Z",
      correctsEventId: original.id,
      payload: {
        kind: "error_cause",
        note: "错因应改为计算",
        overrideErrorCause: "calculation",
      },
    });
    const storedOriginal = await events.get({ workspaceId, eventId: original.id });

    expect(correction.correctsEventId).toBe(original.id);
    expect(storedOriginal.payload).toEqual(attemptPayload);
    expect(storedOriginal.contentVersion).toBe(3);
  });

  it("rejects workspace and owner mismatches", async () => {
    await expect(
      events.append({
        workspaceId,
        ownerUserId: otherUserId,
        type: "attempt",
        idempotencyKey: "attempt-key-03",
        occurredAt,
        contentId,
        contentVersion: 1,
        syllabusPointId,
        payload: attemptPayload,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });

    const created = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-04",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: attemptPayload,
    });
    await expect(events.get({ workspaceId: otherWorkspaceId, eventId: created.id })).rejects.toMatchObject({
      code: "WORKSPACE_MISMATCH",
    });
  });

  it("rejects in-place updates so historical payloads stay immutable", async () => {
    const created = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-05",
      occurredAt,
      contentId,
      contentVersion: 2,
      syllabusPointId,
      payload: attemptPayload,
    });

    await expect(
      sql`UPDATE learning_events SET payload = ${sql.json({ answer: "tampered" })} WHERE id = ${created.id}`,
    ).rejects.toThrow(/append-only/i);

    const stored = await events.get({ workspaceId, eventId: created.id });
    expect(stored.payload).toEqual(attemptPayload);
  });

  it("rejects direct deletion while allowing correction append", async () => {
    const event = await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-delete-guard-01",
      occurredAt,
      contentId,
      contentVersion: 1,
      syllabusPointId,
      payload: attemptPayload,
    });

    await expect(sql`DELETE FROM learning_events WHERE id = ${event.id}`).rejects.toThrow(
      /learning_events are append-only/,
    );

    await expect(events.append({
      workspaceId,
      ownerUserId,
      type: "correction",
      idempotencyKey: "correction-after-delete-guard-01",
      occurredAt: "2026-08-15T03:05:00.000Z",
      correctsEventId: event.id,
      syllabusPointId,
      payload: {
        kind: "status",
        note: "状态需要人工复核",
        overrideStatus: "weak",
      },
    })).resolves.toMatchObject({
      type: "correction",
      correctsEventId: event.id,
    });
  });
});
