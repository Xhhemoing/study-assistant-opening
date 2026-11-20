import { expect, it, vi } from "vitest";
import { assertPracticeDraftSaved, emptyPracticeDraft, parsePracticeDraftCollection, patchPracticeDraft, practiceScope, readPartitionedPracticeDraftCollection, readPracticeDraft, readPracticeDraftCollection, switchPracticeDraft, writePracticeDraft } from "./practice-draft-storage";
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

it.each([
  ["cold", "malformed"],
  ["cold", "unreadable"],
  ["cached", "malformed"],
  ["cached", "invalid schema"],
  ["cached", "unreadable"],
] as const)("reads and saves manual drafts on a %s load with %s ordinary storage", (cache, mode) => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const manualKey = `opening-practice:v2:${manual}`;
  const legacy = emptyPracticeDraft(ordinary, { answer: "saved ordinary answer" });
  const saved = emptyPracticeDraft(manual, { answer: "saved manual answer" });
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  const validOrdinary = JSON.stringify({ version: 2, scope: ordinary, activeId: legacy.id, drafts: [legacy] });
  if (cache === "cached") {
    disk.data.set(ordinaryKey, validOrdinary);
    expect(readPracticeDraft(ordinary, disk)).toEqual(legacy);
  }
  const rawOrdinary = mode === "malformed" ? "{broken" : mode === "invalid schema" ? '{"version":2}' : validOrdinary;
  disk.data.set(ordinaryKey, rawOrdinary);
  disk.data.set(manualKey, JSON.stringify({ version: 2, scope: manual, activeId: saved.id, drafts: [saved] }));
  if (mode === "unreadable") {
    disk.getItem.mockImplementation(key => {
      if (key === ordinaryKey) throw new Error("denied");
      return disk.data.get(key) ?? null;
    });
  }

  const scopes = { ordinary, manual };
  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(manual), disk))
    .toMatchObject({ activeId: saved.id, drafts: [saved] });
  expect(patchPracticeDraft(manual, {}, { fields: { answer: "edited manual answer" } }, disk).persisted).toBe(true);
  expect(parsePracticeDraftCollection(JSON.parse(disk.data.get(manualKey)!), manual)?.drafts[0]?.fields.answer)
    .toBe("edited manual answer");
  expect(() => readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary), disk)).toThrow();
  expect(disk.data.get(ordinaryKey)).toBe(rawOrdinary);
});

it("reopens manual practice after a failed matrix-only cleanup and retries from live ordinary storage", () => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const legacy = emptyPracticeDraft(ordinary, { answer: "legacy manual answer" });
  const matrix = emptyPracticeDraft(ordinary, { matrixMode: true, answer: "matrix answer" });
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  const rawOrdinary = JSON.stringify({ version: 2, scope: ordinary, activeId: legacy.id, drafts: [legacy, matrix] });
  disk.data.set(ordinaryKey, rawOrdinary);
  expect(readPracticeDraft(ordinary, disk)).toEqual(legacy);
  disk.setItem.mockImplementation((key, value) => {
    if (key === ordinaryKey) throw new Error("cleanup write denied");
    disk.data.set(key, value);
  });

  const scopes = { ordinary, manual };
  const fallback = emptyPracticeDraft(manual);
  expect(readPartitionedPracticeDraftCollection(scopes, fallback, disk))
    .toMatchObject({ activeId: legacy.id, drafts: [{ ...legacy, scope: manual }] });
  expect(disk.data.get(ordinaryKey)).toBe(rawOrdinary);
  const edited = patchPracticeDraft(manual, {}, { fields: { answer: "edited manual answer" } }, disk);
  expect(edited.persisted).toBe(true);

  const updatedMatrix = { ...matrix, fields: { ...matrix.fields, answer: "newer matrix answer" } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: matrix.id, drafts: [legacy, updatedMatrix] }));
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });
  expect(readPartitionedPracticeDraftCollection(scopes, fallback, disk))
    .toMatchObject({ activeId: legacy.id, drafts: [edited.draft] });
  expect(parsePracticeDraftCollection(JSON.parse(disk.data.get(ordinaryKey)!), ordinary))
    .toMatchObject({ activeId: matrix.id, drafts: [updatedMatrix] });
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

it("restores the exact selected photo alongside the original text after switching practice drafts", () => {
  const { scope, saved, disk } = setup();
  const photo = { workSourceId: "99999999-9999-4999-8999-999999999999", workSourceVersion: 3, workPhysicalPage: 2 };
  patchPracticeDraft(scope, {}, { fields: photo }, disk, saved.id);
  const another = emptyPracticeDraft(scope);
  switchPracticeDraft(scope, saved.id, another, disk);
  switchPracticeDraft(scope, another.id, saved.id, disk);
  expect(readPracticeDraft(scope, null)?.fields).toMatchObject({ ...photo, answer: saved.fields.answer });
  const persisted = JSON.parse(disk.data.get(`opening-practice:v2:${scope}`)!);
  expect(parsePracticeDraftCollection(persisted, scope)?.drafts.find(item => item.id === saved.id)?.fields).toMatchObject(photo);
});

it("reads older drafts without photo fields without losing the frozen answer", () => {
  const { scope, saved } = setup();
  const { workSourceId: _id, workSourceVersion: _version, workPhysicalPage: _page, ...fields } = saved.fields;
  const restored = parsePracticeDraftCollection({ version: 2, scope, activeId: saved.id, drafts: [{ ...saved, fields }] }, scope);
  expect(restored?.drafts[0]?.fields).toMatchObject({ answer: saved.fields.answer, workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 });
  expect(restored?.drafts[0]?.submission).toEqual(saved.submission);
});

it("restores a pasted question without a source and still rejects changes to its frozen text", () => {
  const scope = practiceScope(courseId, "ordinary", null, { skillLabel: "pasted", requirementKey: null });
  const draft = emptyPracticeDraft(scope, { skillLabel: "pasted", stem: "17 × 23", sourceId: "" });
  const clientKey = "pasted-question-key";
  const saved = { ...draft, attemptId, start: { sessionId, sessionInput: { courseId, skillLabel: "pasted", sourceIds: [] }, clientKey,
    createInput: { sessionId, clientKey, problem: { stemSnapshot: "17 × 23", artifactKind: "reference_item" as const } } } };
  const collection = { version: 2, scope, activeId: saved.id, drafts: [saved] };
  expect(parsePracticeDraftCollection(collection, scope)?.drafts[0]).toEqual(saved);
  expect(parsePracticeDraftCollection({ ...collection, drafts: [{ ...saved, fields: { ...saved.fields, stem: "changed" } }] }, scope)).toBeNull();
  expect(parsePracticeDraftCollection({ ...collection, drafts: [{ ...saved, fields: { ...saved.fields, sourceId: attemptId } }] }, scope)).toBeNull();
});

it("refreshes a stale ordinary cache when live ordinary storage becomes matrix-only after failed cleanup", () => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const legacy = emptyPracticeDraft(ordinary, { answer: "legacy manual answer" });
  const matrix = emptyPracticeDraft(ordinary, { matrixMode: true, answer: "older matrix answer" });
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: legacy.id, drafts: [legacy, matrix] }));
  expect(readPracticeDraft(ordinary, disk)).toEqual(legacy);
  disk.setItem.mockImplementation((key, value) => {
    if (key === ordinaryKey) throw new Error("cleanup write denied");
    disk.data.set(key, value);
  });

  const scopes = { ordinary, manual };
  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(manual), disk))
    .toMatchObject({ activeId: legacy.id });

  const newerMatrix = { ...matrix, fields: { ...matrix.fields, answer: "newer matrix answer" } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: matrix.id, drafts: [newerMatrix] }));
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });

  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary, { matrixMode: true }), disk))
    .toMatchObject({ activeId: matrix.id, drafts: [newerMatrix] });
  const edited = patchPracticeDraft(ordinary, { matrixMode: true }, { fields: { answer: "edited newer matrix" } }, disk);
  expect(edited.persisted).toBe(true);
  expect(parsePracticeDraftCollection(JSON.parse(disk.data.get(ordinaryKey)!), ordinary))
    .toMatchObject({ activeId: matrix.id, drafts: [edited.draft] });
});

it("keeps an unsaved in-memory matrix answer recoverable when the next ordinary storage read throws", () => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const matrix = emptyPracticeDraft(ordinary, { matrixMode: true, answer: "initial matrix" });
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: matrix.id, drafts: [matrix] }));

  const scopes = { ordinary, manual };
  expect(readPartitionedPracticeDraftCollection(scopes, matrix, disk))
    .toMatchObject({ activeId: matrix.id, drafts: [matrix] });

  disk.setItem.mockImplementation(() => { throw new Error("quota exceeded"); });
  const unsaved = patchPracticeDraft(ordinary, { matrixMode: true }, { fields: { answer: "unsaved matrix answer" } }, disk);
  expect(unsaved.persisted).toBe(false);

  disk.getItem.mockImplementation(key => {
    if (key === ordinaryKey) throw new Error("storage read denied");
    return disk.data.get(key) ?? null;
  });

  const liveManual = emptyPracticeDraft(ordinary, { answer: "newer manual answer in live storage" });
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: liveManual.id, drafts: [liveManual, matrix] }));
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });

  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary, { matrixMode: true }), disk))
    .toMatchObject({ activeId: matrix.id, drafts: [unsaved.draft] });
  const recoveredEdit = patchPracticeDraft(ordinary, { matrixMode: true }, { fields: { answer: "still editable in memory" } }, disk);
  expect(recoveredEdit.draft.fields.answer).toBe("still editable in memory");
  expect(recoveredEdit.persisted).toBe(false);
  expect(parsePracticeDraftCollection(JSON.parse(disk.data.get(ordinaryKey)!), ordinary)?.drafts.map(d => d.fields.answer))
    .toContain("newer manual answer in live storage");

  disk.getItem.mockImplementation(key => disk.data.get(key) ?? null);
  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(manual), disk))
    .toMatchObject({ activeId: liveManual.id, drafts: [expect.objectContaining({ id: liveManual.id, scope: manual, fields: expect.objectContaining({ answer: "newer manual answer in live storage" }) })] });
  expect(parsePracticeDraftCollection(JSON.parse(disk.data.get(ordinaryKey)!), ordinary))
    .toMatchObject({ activeId: matrix.id, drafts: [expect.objectContaining({ id: matrix.id, fields: expect.objectContaining({ answer: "still editable in memory" }) })] });
});

it("preserves newer stored answers on untouched drafts while reconciling a locally edited draft", () => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const draftA = emptyPracticeDraft(ordinary, { matrixMode: true, answer: "initial A" });
  const draftB = emptyPracticeDraft(ordinary, { matrixMode: true, matrixVariant: 1, answer: "initial B" });
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: draftA.id, drafts: [draftA, draftB] }));

  const scopes = { ordinary, manual };
  expect(readPartitionedPracticeDraftCollection(scopes, draftA, disk))
    .toMatchObject({ activeId: draftA.id, drafts: [draftA, draftB] });

  disk.setItem.mockImplementation(() => { throw new Error("quota exceeded"); });
  const editedA = patchPracticeDraft(ordinary, { matrixMode: true }, { fields: { answer: "edited A locally" } }, disk, draftA.id);
  expect(editedA.persisted).toBe(false);

  const newerB = { ...draftB, fields: { ...draftB.fields, answer: "newer B saved elsewhere" } };
  disk.data.set(ordinaryKey, JSON.stringify({ version: 2, scope: ordinary, activeId: draftB.id, drafts: [draftA, newerB] }));
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });

  const reconciled = readPartitionedPracticeDraftCollection(scopes, draftA, disk);
  expect(reconciled?.drafts.map(d => [d.id, d.fields.answer])).toEqual([
    [draftA.id, "edited A locally"],
    [draftB.id, "newer B saved elsewhere"],
  ]);
});

it("reuses the assigned identity without duplicating a legacy v1 matrix draft without ID after save and read outages", () => {
  const course = crypto.randomUUID();
  const ordinary = practiceScope(course, "ordinary");
  const manual = practiceScope(course, "manual");
  const legacyKey = `opening-practice:v1:${ordinary}`;
  const ordinaryKey = `opening-practice:v2:${ordinary}`;
  const { id: _omittedId, ...legacyWithoutId } = emptyPracticeDraft(ordinary, { matrixMode: true, answer: "legacy matrix v1" });
  void _omittedId;
  const disk = { ...storage(), removeItem: (key: string) => { disk.data.delete(key); } };
  disk.data.set(legacyKey, JSON.stringify(legacyWithoutId));

  const scopes = { ordinary, manual };
  const initial = readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary, { matrixMode: true }), disk);
  expect(initial?.drafts).toHaveLength(1);
  const assignedId = initial!.drafts[0]!.id;

  disk.setItem.mockImplementation(() => { throw new Error("quota exceeded"); });
  const edited = patchPracticeDraft(ordinary, { matrixMode: true }, { fields: { answer: "edited legacy matrix" } }, disk);
  expect(edited.persisted).toBe(false);

  disk.getItem.mockImplementation(key => {
    if (key === ordinaryKey || key === legacyKey) throw new Error("read outage");
    return disk.data.get(key) ?? null;
  });
  expect(readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary, { matrixMode: true }), disk))
    .toMatchObject({ activeId: assignedId, drafts: [edited.draft] });

  disk.getItem.mockImplementation(key => disk.data.get(key) ?? null);
  disk.setItem.mockImplementation((key, value) => { disk.data.set(key, value); });
  const recovered = readPartitionedPracticeDraftCollection(scopes, emptyPracticeDraft(ordinary, { matrixMode: true }), disk);
  expect(recovered?.drafts).toHaveLength(1);
  expect(recovered?.drafts[0]).toMatchObject({ id: assignedId, fields: { answer: "edited legacy matrix" } });
  expect(disk.data.has(legacyKey)).toBe(false);
});
