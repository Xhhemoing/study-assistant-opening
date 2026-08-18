import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAttemptResponseSchema } from "@aistudy/contracts";
import { createMockProvider } from "./mock/provider";
import type { StorageLike } from "./mock/storage";
import { withPersistedAttempts } from "./persist-attempt";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const eventId = "66666666-6666-4666-8666-666666666666";
const now = "2026-08-15T03:30:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withPersistedAttempts", () => {
  it("writes the attempt through the public API before keeping local status", async () => {
    const provider = createMockProvider({
      userId: "33333333-3333-4333-8333-333333333333",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const item = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(item).not.toBeNull();
    if (!item) return;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          submitAttemptResponseSchema.parse({
            event: {
              id: eventId,
              ownerUserId: "33333333-3333-4333-8333-333333333333",
              practiceItemId: item.id,
              syllabusPointId: item.syllabusPointId,
              idempotencyKey: "attempt-persist-001",
              answer: item.answer,
              correct: true,
              assisted: false,
              durationMs: 1000,
              hintCount: 0,
              confidence: 4,
              errorCause: null,
              abilitySlice: item.abilitySlice,
              contentVersion: item.contentVersion,
              schemaVersion: 1,
              createdAt: now,
            },
            status: {
              syllabusPointId: item.syllabusPointId,
              status: "usable",
              summaryMetrics: [{ key: "coverage", label: "证据覆盖", value: "有效证据 1/6" }],
              reasonCodes: ["partial-mastery"],
              recommendedActions: [{ code: "variant", label: "1道变式题巩固", estimatedMinutes: 10 }],
              evidenceSnapshotId: "snap-test",
              strategyVersion: "assess-1",
              modelVersion: "rules-2",
              computedAt: now,
            },
          }),
        ),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await withPersistedAttempts(provider).submitAttempt({
      practiceItemId: item.id,
      practiceSessionId: "88888888-8888-4888-8888-888888888888",
      answer: item.answer,
      durationMs: 1000,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-persist-001",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      practiceSessionId: "88888888-8888-4888-8888-888888888888",
      answer: item.answer,
      confidence: 4,
      errorCause: null,
      idempotencyKey: "attempt-persist-001",
    });
    expect(sent).not.toHaveProperty("correct");
    expect(sent).not.toHaveProperty("syllabusPointId");
    expect(result.event.id).toBe(eventId);
    expect(result.status.syllabusPointId).toBe(item.syllabusPointId);
  });

  it("keeps the mock submit path when no practice session exists yet", async () => {
    const provider = createMockProvider({
      userId: "33333333-3333-4333-8333-333333333333",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const item = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(item).not.toBeNull();
    if (!item) return;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await withPersistedAttempts(provider).submitAttempt({
      practiceItemId: item.id,
      answer: item.answer,
      durationMs: 1000,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-persist-local",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.event.practiceItemId).toBe(item.id);
    expect(result.status.syllabusPointId).toBe(item.syllabusPointId);
  });

  it("keeps local state untouched when the API write fails", async () => {
    const provider = createMockProvider({
      userId: "33333333-3333-4333-8333-333333333333",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const item = await provider.getPracticeItem("22222222-2222-4222-8222-222222222201");
    expect(item).not.toBeNull();
    if (!item) return;

    const localSubmit = vi.spyOn(provider, "submitAttempt");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));

    const input = {
      practiceItemId: item.id,
      practiceSessionId: "88888888-8888-4888-8888-888888888888",
      answer: item.answer,
      durationMs: 1000,
      hintCount: 0,
      confidence: 4,
      errorCause: null,
      assisted: false,
      idempotencyKey: "attempt-persist-002",
    };
    const snapshot = { ...input };

    await expect(withPersistedAttempts(provider).submitAttempt(input)).rejects.toThrow();

    expect(localSubmit).not.toHaveBeenCalled();
    expect(input).toEqual(snapshot);
  });
});
