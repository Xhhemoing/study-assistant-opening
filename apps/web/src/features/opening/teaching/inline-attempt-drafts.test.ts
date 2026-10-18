import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineAttemptDrafts, inlineAttemptDraftConflict, inlineAttemptIdentityKey, type InlineAttemptDraftStorage } from "./inline-attempt-drafts";
import { OpeningApiError } from "../client/api";
import { createInlineAttemptSubmission, readInlineAttemptObservationHead, type InlineAttemptSubmissionCheckpoint } from "./inline-attempt-submission";
import type { LearningAttempt } from "@aistudy/contracts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const input = { activityId: id, courseId: id, blockId: id, contentVersion: 3, sourceIds: [id], prompt: "旧版题干", skillLabel: "矩阵秩", answer: "尚未确认的答案" };
const draft = { answer: input.answer, skillLabel: input.skillLabel, prompt: input.prompt };
const key = inlineAttemptIdentityKey(id, id, 3);
const canonicalAttempt: LearningAttempt = { id, workspaceId: id, courseId: id, sessionId: id, skillLabel: input.skillLabel,
  requirementKey: `teaching:${id}:v3`, sourceIds: [id], sourceVersions: { [id]: 1 }, problemId: null, itemVersionId: null,
  startedAt: "2026-10-18T00:00:00.000Z", submittedAt: null, observationId: null, historyRevision: 1 };
const savedObservation = { id, attemptId: id, courseId: id, sessionId: id, answer: input.answer, outcome: "unverified" };
function memoryStorage() {
  const values = new Map<string, string>();
  const storage: InlineAttemptDraftStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}
function withSubmission(checkpoint: InlineAttemptSubmissionCheckpoint) { return { ...draft, submission: checkpoint }; }

afterEach(() => { vi.unstubAllGlobals(); });

describe("inline attempt draft continuity", () => {
  it("restores a per-tab answer after the form store is recreated without applying an old revision to the new prompt", () => {
    const { storage } = memoryStorage();
    createInlineAttemptDrafts(storage).set(key, draft);
    const restored = createInlineAttemptDrafts(storage);
    expect(restored.get(key)).toEqual(draft);
    expect(restored.get(inlineAttemptIdentityKey(id, id, 4))).toBeUndefined();
    expect(restored.previous(id, id, 4)).toEqual([[key, draft]]);
    expect(restored.previous(otherId, id, 4)).toEqual([]);
    expect(restored.previous(id, otherId, 4)).toEqual([]);
    expect(createInlineAttemptDrafts(memoryStorage().storage).get(key)).toBeUndefined();
    restored.set(key, null);
    expect(createInlineAttemptDrafts(storage).get(key)).toBeUndefined();
  });

  it("keeps a recovered request read-only after course reassociation or a changed prompt", () => {
    const submitted = withSubmission({ input, attemptKey: `teaching-attempt:${id}`, submitKey: `teaching-answer:${id}`, sessionId: id, attemptId: id, status: "pending" });
    expect(inlineAttemptDraftConflict(submitted, { courseId: otherId, prompt: input.prompt })).toBe("course_changed");
    expect(inlineAttemptDraftConflict(submitted, { courseId: id, prompt: "新版题干" })).toBe("prompt_changed");
    expect(inlineAttemptDraftConflict(submitted, { courseId: id, prompt: input.prompt })).toBeNull();
    expect(inlineAttemptDraftConflict(draft, { courseId: otherId, prompt: input.prompt })).toBeNull();
    expect(inlineAttemptDraftConflict(draft, { courseId: id, prompt: "新版题干" })).toBe("prompt_changed");
  });

  it("ignores malformed, oversized, extra-field and cross-activity persisted data", () => {
    const { storage, values } = memoryStorage();
    const drafts = createInlineAttemptDrafts(storage);
    drafts.set(key, draft);
    const storageKey = [...values.keys()][0]!;
    for (const raw of ["{", JSON.stringify({ ...draft, answer: "x".repeat(20_001) }), JSON.stringify({ ...draft, observation: { id } })]) {
      values.set(storageKey, raw);
      expect(drafts.get(key)).toBeUndefined();
    }
    const submission = { input: { ...input, activityId: otherId }, attemptKey: `teaching-attempt:${id}`, submitKey: `teaching-answer:${id}`, sessionId: id, attemptId: id, status: "pending" };
    values.set(storageKey, JSON.stringify({ ...draft, submission }));
    expect(drafts.get(key)).toBeUndefined();
    values.set(storageKey, JSON.stringify({ ...draft, answer: "a different answer", submission: { ...submission, input } }));
    expect(drafts.get(key)).toBeUndefined();
  });

  it("keeps an unknown submission's exact session, attempt and write keys across a document reload", async () => {
    const { storage } = memoryStorage();
    const drafts = createInlineAttemptDrafts(storage);
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt), submitAttempt: vi.fn().mockRejectedValue(new Error("reply lost")) };
    const original = createInlineAttemptSubmission(input, client, { onCheckpoint: checkpoint => drafts.set(key, withSubmission(checkpoint)) });
    await expect(original.submit()).rejects.toThrow("reply lost");
    const recovered = createInlineAttemptDrafts(storage).get(key)!;
    expect(recovered.answer).toBe(input.answer);
    expect(recovered.submission).toMatchObject({ sessionId: id, attemptId: id, status: "pending" });
    vi.resetModules(); // New document: no surviving controller or promise.
    const { createInlineAttemptSubmission: restore } = await import("./inline-attempt-submission");
    client.submitAttempt.mockResolvedValue(savedObservation);
    const result = await restore(input, client, { checkpoint: recovered.submission, onCheckpoint: checkpoint => drafts.set(key, withSubmission(checkpoint)) }).submit();
    expect(result.attempt).toBe(canonicalAttempt);
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt).toHaveBeenCalledTimes(2);
    expect(client.createAttempt.mock.calls[1]).toEqual(client.createAttempt.mock.calls[0]);
    expect(client.submitAttempt.mock.calls[1]).toEqual(client.submitAttempt.mock.calls[0]);
    // Confirmed answers retain the checkpoint: remounts cannot invent a fresh independent answer.
    expect(createInlineAttemptDrafts(storage).get(key)?.submission).toMatchObject({ attemptId: id, status: "saved" });
    vi.resetModules();
    const { createInlineAttemptSubmission: reloadSaved } = await import("./inline-attempt-submission");
    await reloadSaved(input, client, { checkpoint: drafts.get(key)!.submission }).submit();
    expect(client.submitAttempt.mock.calls[2]).toEqual(client.submitAttempt.mock.calls[0]);
    expect(client.createAttempt).toHaveBeenCalledTimes(3);
  });

  it("retains the frozen request after a 409 instead of creating a new independent attempt", async () => {
    const { storage } = memoryStorage();
    const drafts = createInlineAttemptDrafts(storage);
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt), submitAttempt: vi.fn().mockRejectedValue(new OpeningApiError(409, "content changed")) };
    const original = createInlineAttemptSubmission(input, client, { onCheckpoint: checkpoint => drafts.set(key, withSubmission(checkpoint)) });
    await expect(original.submit()).rejects.toMatchObject({ status: 409 });
    const frozen = drafts.get(key)!;
    vi.resetModules();
    const { createInlineAttemptSubmission: restore } = await import("./inline-attempt-submission");
    await expect(restore(input, client, { checkpoint: frozen.submission }).submit()).rejects.toMatchObject({ status: 409 });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt).toHaveBeenCalledTimes(2);
    expect(client.createAttempt.mock.calls[1]).toEqual(client.createAttempt.mock.calls[0]);
    expect(client.submitAttempt.mock.calls[1]).toEqual(client.submitAttempt.mock.calls[0]);
    expect(drafts.get(key)).toEqual(frozen);
  });

  it("restores the effective self-comparison and stops when that answer was retracted", async () => {
    const revised = { id: otherId, outcome: "correct", referenceCheck: { method: "learner_self_compare" }, revisionKind: "replace" };
    const client = { getObservationHistory: vi.fn().mockResolvedValue({ headObservationId: otherId, revisions: [{ id, outcome: "unverified" }, revised] }) };
    expect(await readInlineAttemptObservationHead(id, client)).toEqual(revised);
    expect(client.getObservationHistory).toHaveBeenCalledWith(id);
    client.getObservationHistory.mockResolvedValue({ headObservationId: otherId, revisions: [{ ...revised, revisionKind: "retract" }] });
    expect(await readInlineAttemptObservationHead(id, client)).toBeNull();
    client.getObservationHistory.mockResolvedValue({ headObservationId: otherId, revisions: [] });
    expect(await readInlineAttemptObservationHead(id, client)).toBeNull();
  });

  it("persists attempt creation intent before sending it and reuses that intent when its reply is lost", async () => {
    const { storage } = memoryStorage();
    const drafts = createInlineAttemptDrafts(storage);
    const client = { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockImplementation(() => {
      expect(drafts.get(key)?.submission).toMatchObject({ sessionId: id, attemptId: null });
      throw new Error("attempt reply lost");
    }), submitAttempt: vi.fn().mockResolvedValue(savedObservation) };
    await expect(createInlineAttemptSubmission(input, client, { onCheckpoint: checkpoint => drafts.set(key, withSubmission(checkpoint)) }).submit()).rejects.toThrow("attempt reply lost");
    vi.resetModules();
    const { createInlineAttemptSubmission: restore } = await import("./inline-attempt-submission");
    client.createAttempt.mockResolvedValue(canonicalAttempt);
    await restore(input, client, { checkpoint: createInlineAttemptDrafts(storage).get(key)!.submission }).submit();
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt.mock.calls[0]).toEqual(client.createAttempt.mock.calls[1]);
    expect(client.submitAttempt).toHaveBeenCalledTimes(1);
  });

  it("shares the still-running request when navigation remounts the form", async () => {
    const { storage } = memoryStorage();
    const drafts = createInlineAttemptDrafts(storage);
    let resolveSession!: (value: { id: string }) => void;
    const client = { createSession: vi.fn().mockImplementation(() => new Promise<{ id: string }>(resolve => { resolveSession = resolve; })), createAttempt: vi.fn().mockResolvedValue(canonicalAttempt), submitAttempt: vi.fn().mockResolvedValue(savedObservation) };
    const first = createInlineAttemptSubmission(input, client, { onCheckpoint: checkpoint => drafts.set(key, withSubmission(checkpoint)) }).submit();
    const remounted = createInlineAttemptSubmission(input, client, { checkpoint: drafts.get(key)!.submission }).submit();
    expect(remounted).toBe(first);
    resolveSession({ id });
    await remounted;
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createAttempt).toHaveBeenCalledTimes(1);
    expect(client.submitAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest answer after a quota failure even when storage can still read the stale answer", async () => {
    const { storage } = memoryStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.resetModules();
    const { createInlineAttemptDrafts: createDrafts } = await import("./inline-attempt-drafts");
    const drafts = createDrafts();
    drafts.set(key, draft);
    const staleAnswer = storage.getItem(storage.key(0)!);
    storage.setItem = () => { throw new Error("quota exceeded"); };
    const newest = { ...draft, answer: "最新答案不能被旧磁盘值覆盖" };
    drafts.set(key, newest);
    expect(storage.getItem(storage.key(0)!)).toBe(staleAnswer);
    expect(drafts.unavailable).toBe(true);
    const remounted = createDrafts();
    expect(remounted.get(key)).toEqual(newest);
    expect(remounted.unavailable).toBe(true);
  });

  it("uses document memory on denied storage and reports that persistence is unavailable", () => {
    const deniedStorage = { ...memoryStorage().storage, getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    vi.stubGlobal("window", { sessionStorage: deniedStorage });
    const drafts = createInlineAttemptDrafts();
    drafts.set(key, draft);
    expect(drafts.unavailable).toBe(true);
    const remounted = createInlineAttemptDrafts();
    expect(remounted.get(key)).toEqual(draft);
    expect(remounted.unavailable).toBe(true);
    remounted.set(key, null);
  });
});
