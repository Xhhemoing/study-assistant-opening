import { describe, expect, it } from "vitest";
import { createInlineAttemptDrafts, inlineAttemptDraftConflict, inlineAttemptIdentityKey, type InlineAttemptDraft, type InlineAttemptDraftStorage } from "./inline-attempt-drafts";
import { readInlineAttemptObservationHead } from "./inline-attempt-submission";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

const activity = "11111111-1111-4111-8111-111111111111";
const block = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const headId = "88888888-8888-4888-8888-888888888888";
function fixture() {
  const values = new Map<string, string>();
  const storage: InlineAttemptDraftStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
  };
  const draft: InlineAttemptDraft = { answer: "synthetic pending answer", prompt: "计算 2+3", skillLabel: "加法",
    submission: { input: { activityId: activity, blockId: block, courseId: activity, contentVersion: 2, sourceIds: [],
      answer: "synthetic pending answer", prompt: "计算 2+3", skillLabel: "加法" },
    attemptKey: `teaching-attempt:${activity}`, submitKey: `teaching-answer:${block}`, sessionId: activity, attemptId: other, status: "pending" } };
  return { storage, draft };
}

describe("teaching persisted revision isolation (pure storage port, not browser or PostgreSQL)", () => {
  it.each([1, 2, 3, 20])("does not transplant a version-2 captured request into version %s", version => {
    const { storage, draft } = fixture(); const key = inlineAttemptIdentityKey(activity, block, 2);
    createInlineAttemptDrafts(storage).set(key, draft);
    const restored = createInlineAttemptDrafts(storage);
    expect(restored.get(inlineAttemptIdentityKey(activity, block, version))).toEqual(version === 2 ? draft : undefined);
    expect(restored.previous(activity, block, version)).toEqual(version === 2 ? [] : [[key, draft]]);
    expect(restored.get(key)).toEqual(draft);
  });

  it.each(["activity", "block", "version", "answer", "prompt", "skill"] as const)("quarantines persisted %s mismatch rather than rebinding a pending request", field => {
    const { storage, draft } = fixture(); const key = inlineAttemptIdentityKey(activity, block, 2);
    if (field === "activity") draft.submission!.input.activityId = other;
    if (field === "block") draft.submission!.input.blockId = other;
    if (field === "version") draft.submission!.input.contentVersion = 3;
    if (field === "answer") draft.answer = "different visible answer";
    if (field === "prompt") draft.prompt = "different visible prompt";
    if (field === "skill") draft.skillLabel = "different skill";
    createInlineAttemptDrafts(storage).set(key, draft);
    const restored = createInlineAttemptDrafts(storage);
    expect(restored.get(key)).toBeUndefined();
    expect(restored.previous(activity, block, 3)).toEqual([]);
  });

  it.each(["course", "prompt", "both"] as const)("reports %s reassociation without rewriting the frozen request", change => {
    const { draft } = fixture(), before = structuredClone(draft);
    expect(inlineAttemptDraftConflict(draft, { courseId: change === "prompt" ? activity : other,
      prompt: change === "course" ? draft.prompt : "new context" })).toBe(change === "course" ? "course_changed" : "prompt_changed");
    expect(draft).toEqual(before);
  });

  it.each([false, true])("explicit old-draft removal cannot delete a newer captured revision (reverse writes=%s)", reverse => {
    const { storage, draft } = fixture(); const store = createInlineAttemptDrafts(storage);
    const newer = { ...draft, answer: "new draft", submission: undefined };
    const oldKey = inlineAttemptIdentityKey(activity, block, 2), newKey = inlineAttemptIdentityKey(activity, block, 3);
    for (const [key, value] of reverse ? [[newKey, newer], [oldKey, draft]] as const : [[oldKey, draft], [newKey, newer]] as const) store.set(key, value);
    store.set(oldKey, null);
    const restored = createInlineAttemptDrafts(storage);
    expect(restored.get(oldKey)).toBeUndefined(); expect(restored.get(newKey)).toEqual(newer);
  });

  it.each(["replace", "retract", "missing"] as const)("effective %s head never falls back to the historical answer", async kind => {
    const original = { ...learningObservation, answer: "historical private answer" };
    const latest = { ...original, id: headId, rootObservationId: original.id, answer: "new answer", revisionKind: kind === "retract" ? "retract" as const : "replace" as const };
    const history = { rootObservationId: original.id, headObservationId: headId, revisions: kind === "missing" ? [original] : [original, latest] };
    const before = structuredClone(history);
    const result = await readInlineAttemptObservationHead(original.id, { getObservationHistory: async () => history });
    expect(result).toEqual(kind === "replace" ? latest : null);
    expect(history).toEqual(before);
  });

  it.each([403, 404])("access withdrawal %s propagates rather than returning an old answer", async status => {
    const denied = Object.assign(new Error("synthetic access withdrawal"), { status });
    await expect(readInlineAttemptObservationHead(activity, { getObservationHistory: async () => { throw denied; } })).rejects.toBe(denied);
  });
});
