import { expect, it, vi } from "vitest";
import { assertPracticeDraftSaved, emptyPracticeDraft, parsePracticeDraftCollection, patchPracticeDraft, practiceScope, readPracticeDraft, readPracticeDraftCollection, switchPracticeDraft, writePracticeDraft } from "./practice-draft-storage";
import { runPracticeRequest } from "./practice-draft";

const courseId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const observationId = "44444444-4444-4444-8444-444444444444";
const newScope = () => practiceScope(courseId, "ordinary", { retestId: crypto.randomUUID(), skillLabel: "scope", prompt: crypto.randomUUID() });
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}
function frozen(scope: string) {
  // This scope intentionally uses a retest only for test isolation; its original retest identity is preserved.
  const retestId = (JSON.parse(scope) as string[])[2]!;
  return { ...emptyPracticeDraft(scope, { skillLabel: "原题", answer: "原答案\n  保留空格 < &" }), attemptId,
    start: { clientKey: `start-${crypto.randomUUID()}`, sessionId, sessionInput: { courseId, skillLabel: "原题", sourceIds: [] }, createInput: { sessionId, clientKey: "placeholder-key" } },
    submission: { attemptId, input: { clientKey: `answer-${crypto.randomUUID()}`, answer: "原答案\n  保留空格 < &", outcome: "unverified" as const, assistance: "independent" as const, retestId } },
  };
}
function setup() {
  const scope = newScope();
  const saved = frozen(scope); saved.start.createInput.clientKey = saved.start.clientKey;
  const disk = storage();
  writePracticeDraft(saved, disk);
  return { scope, saved, disk };
}

it("starts another practice without losing a frozen request, then restores exact original bytes and keys", () => {
  const { scope, saved, disk } = setup();
  const next = emptyPracticeDraft(scope, { skillLabel: "新题" });
  switchPracticeDraft(scope, saved.id, next, disk);
  patchPracticeDraft(scope, {}, { fields: { answer: "new work" } }, disk, next.id);
  const restored = switchPracticeDraft(scope, next.id, saved.id, disk);
  expect(restored.activeId).toBe(saved.id);
  expect(readPracticeDraft(scope, null)).toEqual(saved);
  expect(restored.drafts.find(value => value.id === next.id)?.fields.answer).toBe("new work");
  const persisted = JSON.parse(disk.data.get(`opening-practice:v2:${scope}`)!);
  expect(parsePracticeDraftCollection(persisted, scope)).toEqual(restored);
});

it("refuses a second same-tick switch from stale controls rather than discarding the new active draft", () => {
  const { scope, saved, disk } = setup();
  const next = emptyPracticeDraft(scope);
  switchPracticeDraft(scope, saved.id, next, disk);
  expect(() => switchPracticeDraft(scope, saved.id, emptyPracticeDraft(scope), disk)).toThrow("已切换");
  expect(readPracticeDraftCollection(scope, null)?.drafts).toHaveLength(2);
  expect(readPracticeDraft(scope, null)?.id).toBe(next.id);
});

it("keeps late start/submit/help callbacks attached to the archived draft", async () => {
  const { scope, saved, disk } = setup();
  let resolve!: (value: string) => void;
  const operation = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const requestKey = saved.submission.input.clientKey;
  const pending = runPracticeRequest(requestKey, operation).then(id => {
    patchPracticeDraft(scope, {}, current => ({ observationId: id, fields: { ...current.fields, assistance: "revealed", deliveredAssistance: "revealed" } }), disk, saved.id);
    return id;
  });
  const next = emptyPracticeDraft(scope, { answer: "new unsent answer" });
  switchPracticeDraft(scope, saved.id, next, disk);
  const joined = runPracticeRequest(requestKey, operation);
  expect(operation).toHaveBeenCalledTimes(1);
  resolve(observationId);
  await expect(Promise.all([pending, joined])).resolves.toEqual([observationId, observationId]);
  expect(readPracticeDraft(scope, null)).toEqual(next);
  const original = readPracticeDraft(scope, null, saved.id)!;
  expect(original.observationId).toBe(observationId);
  expect(original.submission).toEqual(saved.submission);
  expect(original.fields.answer).toBe(saved.fields.answer);
  switchPracticeDraft(scope, next.id, saved.id, disk);
  expect(readPracticeDraft(scope, null)?.fields.deliveredAssistance).toBe("revealed");
});

it.each(["archive", "restore"] as const)("cancels %s on denied/quota storage without changing the active draft or losing latest inputs", mode => {
  const { scope, saved, disk } = setup();
  const next = emptyPracticeDraft(scope, { answer: "new" });
  if (mode === "restore") switchPracticeDraft(scope, saved.id, next, disk);
  const active = readPracticeDraft(scope, null)!;
  disk.setItem.mockImplementation(() => { throw new Error("quota or denied"); });
  patchPracticeDraft(scope, {}, { fields: { referenceSkipped: true } }, disk, active.id);
  expect(() => switchPracticeDraft(scope, active.id, mode === "archive" ? next : saved.id, disk)).toThrow("已取消切换");
  expect(readPracticeDraft(scope, null)?.id).toBe(active.id);
  expect(readPracticeDraft(scope, null)?.fields.referenceSkipped).toBe(true);
  expect(() => assertPracticeDraftSaved(scope)).toThrow("已暂停发送");
  expect(readPracticeDraft(scope, null, saved.id)?.fields.answer).toBe(saved.fields.answer);
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });
  expect(() => switchPracticeDraft(scope, active.id, mode === "archive" ? next : saved.id, disk)).not.toThrow();
  expect(() => assertPracticeDraftSaved(scope)).not.toThrow();
});

it("rejects malformed collection identity and any corrupted or cross-scope archived checkpoint", () => {
  const { scope, saved } = setup();
  const valid = { version: 2, scope, activeId: saved.id, drafts: [saved] };
  expect(parsePracticeDraftCollection(valid, scope)).not.toBeNull();
  expect(parsePracticeDraftCollection({ ...valid, activeId: crypto.randomUUID() }, scope)).toBeNull();
  expect(parsePracticeDraftCollection({ ...valid, drafts: [saved, saved] }, scope)).toBeNull();
  const { id: _id, ...missingId } = saved;
  expect(parsePracticeDraftCollection({ ...valid, drafts: [saved, missingId] }, scope)).toBeNull();
  expect(parsePracticeDraftCollection({ ...valid, drafts: [saved, { ...saved, id: crypto.randomUUID(), scope: newScope() }] }, scope)).toBeNull();
});

it.each(["corrupt", "denied"] as const)("blocks fresh writes when existing storage is %s and can retry without clearing it", mode => {
  const scope = newScope();
  const disk = storage();
  if (mode === "corrupt") disk.data.set(`opening-practice:v2:${scope}`, "{broken");
  else disk.getItem.mockImplementation(() => { throw new Error("denied"); });
  expect(() => readPracticeDraftCollection(scope, disk)).toThrow();
  expect(() => patchPracticeDraft(scope, {}, { fields: { answer: "must not replace old data" } }, disk)).toThrow();
  expect(disk.setItem).not.toHaveBeenCalled();
  const repaired = emptyPracticeDraft(scope, { answer: "restored browser copy" });
  disk.getItem.mockImplementation(key => disk.data.get(key) ?? null);
  disk.data.set(`opening-practice:v2:${scope}`, JSON.stringify({ version: 2, scope, activeId: repaired.id, drafts: [repaired] }));
  expect(readPracticeDraft(scope, disk)?.fields.answer).toBe("restored browser copy");
});

it("loads a legacy draft once with a stable local identity while preserving frozen server request keys", () => {
  const scope = newScope();
  const saved = frozen(scope); saved.start.createInput.clientKey = saved.start.clientKey;
  const { id: _id, ...legacy } = saved;
  const disk = storage();
  disk.data.set(`opening-practice:v1:${scope}`, JSON.stringify(legacy));
  const first = readPracticeDraft(scope, disk)!;
  expect(readPracticeDraft(scope, disk)?.id).toBe(first.id);
  expect(first.start?.clientKey).toBe(saved.start.clientKey);
  expect(first.submission).toEqual(saved.submission);
  expect(disk.setItem).not.toHaveBeenCalled();
});
