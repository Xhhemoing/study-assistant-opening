import { z } from "zod";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningSessionCreateInputSchema, matrixExerciseInputSchema, type MatrixExerciseInput } from "@aistudy/contracts";

const fieldsSchema = z.object({
  sourceId: z.string().max(200), referenceSourceId: z.string().max(200), skillLabel: z.string().max(200),
  stem: z.string().max(4000), answer: z.string().max(20000),
  workSourceId: z.string().max(200).default(""), workSourceVersion: z.number().int().nonnegative().default(0),
  workPhysicalPage: z.number().int().positive().default(1),
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  assistance: z.enum(["unknown", "independent", "hinted", "revealed"]),
  deliveredAssistance: z.enum(["none", "hinted", "revealed"]),
  spanProblemId: z.string().max(100).default(""), spanVersion: z.number().int().positive().default(1),
  referenceSkipped: z.boolean(), matrixMode: z.boolean(),
  matrixKey: z.enum(["dimensions", "addition", "scalar", "multiplication"]), matrixVariant: z.number().int().min(0).max(8),
}).strict();
const startSchema = z.object({
  clientKey: z.string().min(8).max(200), sessionId: z.string().uuid().nullable(),
  sessionInput: learningSessionCreateInputSchema.nullable(), createInput: learningAttemptCreateInputSchema.nullable(),
}).strict().refine(value => value.createInput === null || (value.createInput.sessionId === value.sessionId && value.createInput.clientKey === value.clientKey));
const draftSchema = z.object({
  version: z.literal(1), id: z.string().uuid().optional(), scope: z.string(), fields: fieldsSchema, start: startSchema.nullable(),
  attemptId: z.string().uuid().nullable(), observationId: z.string().uuid().nullable(),
  submission: z.object({ attemptId: z.string().uuid(), input: learningAttemptSubmitInputSchema }).strict().nullable(),
  disputeKey: z.string().min(8).max(200).nullable(),
}).strict().refine(value => value.submission === null || value.submission.attemptId === value.attemptId);

export type PracticeFields = z.infer<typeof fieldsSchema>;
export type PracticeDraft = z.infer<typeof draftSchema> & { id: string };
export type PracticeStart = NonNullable<PracticeDraft["start"]>;
export type PracticeDraftCollection = { version: 2; scope: string; activeId: string; drafts: PracticeDraft[] };
export type DraftPatch = Partial<Omit<PracticeDraft, "scope" | "version" | "id" | "fields">> & { fields?: Partial<PracticeFields> };
const memory = new Map<string, PracticeDraftCollection>();
// Full-snapshot edits are relative to a clean caller snapshot, even after a failed rebase.
const cleanBase = new Map<string, PracticeDraftCollection>();
const initializedCollections = new WeakSet<PracticeDraftCollection>();
type PendingDraftEdit = { patch: DraftPatch; written: DraftPatch };
const dirtyDrafts = new Map<string, Map<string, PendingDraftEdit>>();
const legacySnapshots = new Map<string, { raw: string; id: string; destination?: string }>();
const pendingArchiveCleanup = new Map<string, { source: PracticeDraft; targetScope: string }>();
const unreconciled = new Set<string>();
const blocked = new Map<string, string>();

function combineDraftPatches(earlier: DraftPatch, later: DraftPatch): DraftPatch {
  return { ...earlier, ...later, fields: { ...earlier.fields, ...later.fields } };
}

function omitProperties<T extends object>(value: T, keys: object): T {
  const remaining = { ...value };
  for (const key of Object.keys(keys)) delete remaining[key as keyof T];
  return remaining;
}

function omitDraftPatchKeys(patch: DraftPatch, keys: DraftPatch): DraftPatch {
  const { fields, ...checkpoint } = keys;
  return { ...omitProperties(patch, checkpoint), fields: omitProperties(patch.fields ?? {}, fields ?? {}) };
}

function applyDraftPatch(draft: PracticeDraft, patch: DraftPatch): PracticeDraft {
  return { ...draft, ...patch, id: draft.id, scope: draft.scope, version: draft.version, fields: { ...draft.fields, ...patch.fields } };
}
const storageKey = (scope: string) => `opening-practice:v2:${scope}`;
const legacyStorageKey = (scope: string) => `opening-practice:v1:${scope}`;
type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;
type PartitionStorage = ReadStorage & WriteStorage & Pick<Storage, "removeItem">;
function isReadStorage(storage: WriteStorage | null): storage is WriteStorage & ReadStorage {
  return Boolean(storage && "getItem" in storage && typeof storage.getItem === "function");
}
function hasRemoveItem(storage: WriteStorage | null): storage is WriteStorage & Pick<Storage, "removeItem"> {
  return Boolean(storage && "removeItem" in storage && typeof storage.removeItem === "function");
}
type StoredPracticeDraftCollection = { collection: PracticeDraftCollection; legacy: boolean; raw: string };

export function practiceScope(courseId: string, mode: "ordinary" | "manual" | "matrix" | "span", retest?: { retestId: string; prompt: string; skillLabel: string; requirementKey?: string | null; retestActivityId?: string } | null, focus?: { skillLabel: string; requirementKey: string | null }, problem?: { sourceId: string; sourceVersion: number }, matrixExercise?: MatrixExerciseInput): string {
  // Retest content/requirement changes never attach an older frozen request to a newer task.
  return JSON.stringify([courseId, mode, retest?.retestId ?? null, retest?.retestActivityId ?? null, retest?.requirementKey ?? null, retest?.skillLabel ?? null, retest?.prompt ?? null,
    ...(!retest && focus ? [focus.skillLabel, focus.requirementKey] : []),
    ...(!retest && problem ? [{ sourceId: problem.sourceId, sourceVersion: problem.sourceVersion }] : []),
    ...(matrixExercise ? [matrixExercise] : [])]);
}

export function emptyPracticeDraft(scope: string, fields: Partial<PracticeFields> = {}): PracticeDraft {
  return { version: 1, id: crypto.randomUUID(), scope, fields: { sourceId: "", referenceSourceId: "", skillLabel: "", stem: "", answer: "", workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1, outcome: "unverified", assistance: "unknown", deliveredAssistance: "none", spanProblemId: "", spanVersion: 1, referenceSkipped: false, matrixMode: false, matrixKey: "multiplication", matrixVariant: 0, ...fields }, start: null, attemptId: null, observationId: null, submission: null, disputeKey: null };
}

export function parsePracticeDraft(raw: unknown, scope: string): PracticeDraft | null {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success || parsed.data.scope !== scope) return null;
  const draft: PracticeDraft = { ...parsed.data, id: parsed.data.id ?? crypto.randomUUID() };
  let context: unknown;
  try { context = JSON.parse(scope); } catch { return null; }
  if (!Array.isArray(context) || ![7, 8, 9, 10].includes(context.length)) return null;
  const [courseId, mode, retestId, , requirementKey] = context;
  if (context.length === 8) {
    if (mode === "matrix") {
      const exercise = matrixExerciseInputSchema.safeParse(context[7]);
      if (!exercise.success || draft.fields.sourceId !== exercise.data.sourceId || draft.fields.matrixKey !== exercise.data.exerciseKey) return null;
    } else if (mode !== "span" || !z.string().uuid().safeParse(context[7]).success) return null;
  }
  if (context.length === 10) {
    const question = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().positive() }).strict().safeParse(context[9]);
    if (!question.success || mode !== "ordinary" || draft.fields.sourceId !== question.data.sourceId) return null;
  }
  const start = draft.start;
  if (context.length >= 9 && (draft.fields.skillLabel !== context[7] || start?.sessionInput && (start.sessionInput.requirementKey ?? null) !== context[8])) return null;
  if (start) {
    if (!start.sessionInput && !start.createInput) return null;
    if (start.sessionInput && start.sessionInput.courseId !== courseId) return null;
    const input = start.createInput;
    if (mode === "matrix") {
      if (retestId !== null) return null;
      if (input && (!input.matrixExercise || input.matrixExercise.sourceId !== draft.fields.sourceId || input.matrixExercise.exerciseKey !== draft.fields.matrixKey || input.matrixExercise.variant !== draft.fields.matrixVariant)) return null;
      if (start.sessionInput && JSON.stringify(start.sessionInput.sourceIds) !== JSON.stringify([draft.fields.sourceId])) return null;
    } else if (mode === "span") {
      if (context[3] !== null && (!z.string().uuid().safeParse(context[3]).success || start.sessionInput?.activityId !== context[3])) return null;
      if (input && (!input.spanExercise || input.spanExercise.sourceId !== draft.fields.sourceId || input.spanExercise.problemId !== draft.fields.spanProblemId || input.spanExercise.version !== draft.fields.spanVersion)) return null;
      if (start.sessionInput && JSON.stringify(start.sessionInput.sourceIds) !== JSON.stringify([draft.fields.sourceId])) return null;
    } else if (mode === "ordinary" || mode === "manual") {
      if (input?.matrixExercise || input?.spanExercise || input?.teachingBlock) return null;
      if (start.sessionInput && start.sessionInput.skillLabel !== draft.fields.skillLabel.trim()) return null;
      if (input?.problem && ((input.problem.sourceId ?? "") !== draft.fields.sourceId || input.problem.stemSnapshot !== draft.fields.stem.trim())) return null;
      if (retestId !== null && ((input && (input.requirementKey ?? null) !== requirementKey) || (start.sessionInput && (start.sessionInput.requirementKey ?? null) !== requirementKey))) return null;
    } else return null;
  }
  if (draft.attemptId && !start?.createInput) return null;
  if (draft.submission && ((draft.submission.input.retestId ?? null) !== retestId || draft.submission.input.answer !== draft.fields.answer || draft.submission.input.outcome !== draft.fields.outcome)) return null;
  return draft;
}

const collectionSchema = z.object({ version: z.literal(2), scope: z.string(), activeId: z.string().uuid(), drafts: z.array(z.object({ id: z.string().uuid() }).passthrough()).min(1) }).strict();

export function parsePracticeDraftCollection(raw: unknown, scope: string): PracticeDraftCollection | null {
  const parsed = collectionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.scope !== scope) return null;
  const drafts = parsed.data.drafts.map(value => parsePracticeDraft(value, scope));
  if (drafts.some(value => value === null)) return null;
  const valid = drafts as PracticeDraft[];
  if (new Set(valid.map(value => value.id)).size !== valid.length || !valid.some(value => value.id === parsed.data.activeId)) return null;
  return { ...parsed.data, drafts: valid };
}

function readStoredPracticeDraftCollection(scope: string, storage: ReadStorage, editing = false): StoredPracticeDraftCollection | null {
  function unreadable(message: string): never { blocked.set(scope, message); throw new Error(message); }
  let raw: string | null;
  let legacy = false;
  try {
    raw = storage.getItem(storageKey(scope));
    if (raw === null) { raw = storage.getItem(legacyStorageKey(scope)); legacy = true; }
  } catch { unreadable("无法读取练习草稿，已停止新建和切换。请允许此页面使用浏览器存储后重试。"); }
  if (raw === null) {
    blocked.delete(scope);
    if (!editing && !dirtyDrafts.has(scope)) legacySnapshots.delete(scope);
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { unreadable("保存的练习草稿无法解析，原内容未改动。请恢复浏览器存储后重试。"); }
  let collection: PracticeDraftCollection | null;
  if (legacy) {
    const parsedDraft = parsePracticeDraft(parsed, scope);
    if (parsedDraft) {
      const snapshot = legacySnapshots.get(scope);
      const id = snapshot?.raw === raw ? snapshot.id : parsedDraft.id;
      // A dirty retry can prefer the in-memory edit over a different v1 draft with the same ID.
      // Only a clean load can establish which v1 bytes those local edits descend from.
      if (!editing && !dirtyDrafts.has(scope) && snapshot?.raw !== raw) legacySnapshots.set(scope, { raw, id });
      const draft = { ...parsedDraft, id };
      collection = { version: 2, scope, activeId: draft.id, drafts: [draft] };
    } else collection = null;
  } else {
    collection = parsePracticeDraftCollection(parsed, scope);
  }
  if (!collection) unreadable("保存的练习草稿身份或内容无效，原内容未改动，已停止新建和切换。");
  blocked.delete(scope);
  return { collection, legacy, raw };
}

function restoreCachedReadFailure(scope: string, previousBlocked: string | undefined): void {
  if (!memory.has(scope)) return;
  if (previousBlocked === undefined) blocked.delete(scope);
  else blocked.set(scope, previousBlocked);
  // Keep the form editable, and require a fresh read before saving its next edit.
  unreconciled.add(scope);
}

function rememberCleanCollection(collection: PracticeDraftCollection): PracticeDraftCollection {
  if (!dirtyDrafts.has(collection.scope)) cleanBase.set(collection.scope, collection);
  return collection;
}

function cacheCollection(collection: PracticeDraftCollection): PracticeDraftCollection {
  memory.set(collection.scope, collection);
  return rememberCleanCollection(collection);
}

function forgetCollection(scope: string): void {
  memory.delete(scope);
  cleanBase.delete(scope);
}

/** A bad stored checkpoint blocks new writes; it is never silently replaced by an empty draft. */
export function readPracticeDraftCollection(scope: string, storage: ReadStorage | null): PracticeDraftCollection | null {
  const cached = memory.get(scope);
  if (cached) return rememberCleanCollection(cached);
  if (!storage) {
    const error = blocked.get(scope);
    if (error) throw new Error(error);
    return null;
  }
  const stored = readStoredPracticeDraftCollection(scope, storage);
  if (!stored) {
    cleanBase.delete(scope);
    return null;
  }
  return cacheCollection(stored.collection);
}

export function initializePracticeDraft(draft: PracticeDraft): PracticeDraftCollection {
  const error = blocked.get(draft.scope);
  if (error) throw new Error(error);
  const cached = memory.get(draft.scope);
  if (cached) return rememberCleanCollection(cached);
  const collection = { version: 2 as const, scope: draft.scope, activeId: draft.id, drafts: [draft] };
  initializedCollections.add(collection);
  return cacheCollection(collection);
}

export function readPracticeDraft(scope: string, storage: ReadStorage | null, draftId?: string): PracticeDraft | null {
  const collection = readPracticeDraftCollection(scope, storage);
  return collection?.drafts.find(draft => draft.id === (draftId ?? collection.activeId)) ?? null;
}

function cleanupLegacyDraft(scope: string, storage: PartitionStorage, migrated: readonly PracticeDraft[], manualScope?: string): boolean {
  const key = legacyStorageKey(scope);
  const raw = storage.getItem(key);
  if (raw === null) {
    legacySnapshots.delete(scope);
    return true;
  }

  const value: unknown = JSON.parse(raw);
  const legacy = parsePracticeDraft(value, scope);
  if (!legacy) return false;
  const hasId = typeof (value as { id?: unknown }).id === "string";
  const destination = manualScope && !legacy.fields.matrixMode ? manualScope : scope;
  const comparable = parsePracticeDraft({ ...legacy, scope: destination }, destination);
  if (!comparable) return false;

  function readDurableDrafts(partition: string) {
    const saved = storage.getItem(storageKey(partition));
    return saved === null ? undefined : parsePracticeDraftCollection(JSON.parse(saved), partition)?.drafts;
  }
  function matchesLegacy(draft: PracticeDraft, expected: PracticeDraft) {
    return JSON.stringify(draft) === JSON.stringify(hasId ? expected : { ...expected, id: draft.id });
  }
  const durable = readDurableDrafts(destination);
  const remembered = legacySnapshots.get(scope);
  const snapshot = remembered?.raw === raw ? remembered : undefined;
  const migratedDraft = snapshot
    ? migrated.find(draft => draft.id === snapshot.id && draft.scope === destination)
    : undefined;
  const edited = migratedDraft && parsePracticeDraft(migratedDraft, destination);
  // An edited copy may supersede the exact v1 bytes we loaded. For any other
  // source, require the full draft in the correct v2 partition before deleting.
  const destinationCopy = durable?.find(draft => {
    if (snapshot?.destination === destination && snapshot.id === draft.id) return true;
    return matchesLegacy(draft, comparable) || (edited && JSON.stringify(draft) === JSON.stringify(edited));
  });
  // After a reload the manual copy may already have been edited. The original
  // in ordinary v2 still proves remigration of those v1 bytes is unnecessary.
  const copy = destinationCopy ?? (destination !== scope && durable
    ? readDurableDrafts(scope)?.find(draft => matchesLegacy(draft, legacy) && durable.some(manual => manual.id === draft.id))
    : undefined);
  if (!copy || storage.getItem(key) !== raw) return false;

  // If removal fails, the same bytes can be cleaned up after further edits to this copy.
  legacySnapshots.set(scope, { raw, id: copy.id, destination });
  storage.removeItem(key);
  legacySnapshots.delete(scope);
  return true;
}

function finishCollectionSave(collection: PracticeDraftCollection, storage: WriteStorage): void {
  dirtyDrafts.delete(collection.scope);
  rememberCleanCollection(collection);
  if (hasRemoveItem(storage) && isReadStorage(storage)) {
    try {
      cleanupLegacyDraft(collection.scope, storage, collection.drafts);
    } catch { /* Keep v1 when cleanup cannot be verified or completed. */ }
  }
}

function persistCollection(collection: PracticeDraftCollection, storage: WriteStorage | null): boolean {
  // An edit rebased onto a frozen request must still match its answer and identity.
  if (!storage || unreconciled.has(collection.scope) || !parsePracticeDraftCollection(collection, collection.scope)) return false;
  try {
    storage.setItem(storageKey(collection.scope), JSON.stringify(collection));
    finishCollectionSave(collection, storage);
    return true;
  } catch { return false; }
}

export type PracticeDraftScopes = { ordinary: string; manual: string };

export function isRecoverableManualDraft(draft: PracticeDraft): boolean {
  return draft.fields.matrixMode !== true && !draft.observationId;
}

function withoutDrafts(collection: PracticeDraftCollection, removedIds: ReadonlySet<string>): PracticeDraftCollection | null {
  const drafts = collection.drafts.filter(draft => !removedIds.has(draft.id));
  const active = drafts.find(draft => draft.id === collection.activeId) ?? drafts[0];
  return active ? { ...collection, activeId: active.id, drafts } : null;
}

function recoverManualAnswer(draft: PracticeDraft, manualScope: string): PracticeDraft | null {
  // The frozen request belongs to the durable original. Recover the edited
  // inputs as a separate draft so they cannot change that request.
  return parsePracticeDraft(emptyPracticeDraft(manualScope, draft.fields), manualScope);
}

function migrateOrdinaryManualDrafts(scopes: PracticeDraftScopes, ordinary: PracticeDraftCollection, source: StoredPracticeDraftCollection | null, fallback: PracticeDraft, storage: PartitionStorage): void {
  const migrationError = "无法迁移练习草稿，原答案已保留。请释放浏览器存储后重试。";
  const manualScope = scopes.manual;
  const manualEntry = fallback.scope === manualScope;
  const previousBlocked = blocked.get(manualScope);
  let storedManual: StoredPracticeDraftCollection | null;
  try {
    storedManual = readStoredPracticeDraftCollection(manualScope, storage);
  } catch (reason) {
    restoreCachedReadFailure(manualScope, previousBlocked);
    throw reason;
  }
  const cachedManual = memory.get(manualScope);
  const manual = cachedManual && dirtyDrafts.has(manualScope)
    ? mergeWithStoredCollection(manualScope, cachedManual, storedManual)
    : storedManual?.collection;
  unreconciled.delete(manualScope);
  if (manual) cacheCollection(manual);
  else forgetCollection(manualScope);
  const manualDrafts: PracticeDraft[] = [];
  const added: PracticeDraft[] = [];
  const unresolvedManualIds = new Set<string>();
  const recoveredAnswers: PracticeDraft[] = [];
  for (const draft of manual?.drafts ?? []) {
    const valid = parsePracticeDraft(draft, manualScope);
    if (valid) {
      manualDrafts.push(valid);
      continue;
    }
    const saved = storedManual?.collection.drafts.find(value => value.id === draft.id);
    if (saved) manualDrafts.push(saved);
    const recovery = recoverManualAnswer(draft, manualScope);
    if (recovery) recoveredAnswers.push(recovery);
    else unresolvedManualIds.add(draft.id);
  }

  function alreadyRecovered(copy: PracticeDraft) {
    return [...manualDrafts, ...added].some(value => JSON.stringify(value) === JSON.stringify({ ...copy, id: value.id }));
  }

  function addCopy(copy: PracticeDraft) {
    const existing = manualDrafts.find(value => value.id === copy.id);
    if (!existing) { added.push(copy); return; }
    // Keep the active destination identity and reuse any recovered copy from a failed cleanup.
    if (JSON.stringify(existing) !== JSON.stringify(copy) && !alreadyRecovered(copy)) {
      added.push({ ...copy, id: crypto.randomUUID() });
    }
  }
  const migratedIds = new Set<string>();
  for (const draft of ordinary.drafts) {
    if (draft.fields.matrixMode) continue;
    const copy = parsePracticeDraft({ ...draft, scope: manualScope }, manualScope);
    if (copy) {
      addCopy(copy);
    } else {
      const recovery = recoverManualAnswer(draft, manualScope);
      const saved = source?.collection.drafts.find(value => value.id === draft.id);
      const savedCopy = saved && parsePracticeDraft({ ...saved, scope: manualScope }, manualScope);
      if (!recovery || (saved && !savedCopy)) continue;
      if (savedCopy) addCopy(savedCopy);
      recoveredAnswers.push(recovery);
    }
    migratedIds.add(draft.id);
  }
  for (const recovery of recoveredAnswers) {
    // A failed source cleanup may have left the edited answer on the shelf already.
    if (!alreadyRecovered(recovery)) added.push(recovery);
  }
  const drafts = [...manualDrafts, ...added];
  const legacyActive = added.find(draft => draft.id === ordinary.activeId && isRecoverableManualDraft(draft));
  const manualFallback = manualEntry ? fallback : emptyPracticeDraft(manualScope);
  const activeId = drafts.find(draft => draft.id === manual?.activeId)?.id ?? legacyActive?.id ?? manualFallback.id;
  if (activeId === manualFallback.id && !drafts.some(draft => draft.id === activeId)) drafts.push(manualFallback);
  const ordinaryKey = storageKey(scopes.ordinary);
  const manualKey = storageKey(manualScope);
  let expectedOrdinary = source?.raw ?? null;
  let expectedManual = storedManual?.raw;

  // A v1 draft can lack an ID. Save the assigned ID before copying so a retry can recognize it.
  if (source?.legacy) {
    try {
      if (storage.getItem(ordinaryKey) !== null || storage.getItem(legacyStorageKey(scopes.ordinary)) !== source.raw) return;
      const durable = parsePracticeDraftCollection(ordinary, scopes.ordinary) ?? source.collection;
      expectedOrdinary = JSON.stringify(durable);
      storage.setItem(ordinaryKey, expectedOrdinary);
      cacheCollection(ordinary);
    } catch {
      if (manualEntry && manual) return;
      throw new Error(migrationError);
    }
  }
  if (!storedManual || storedManual.legacy || added.length || dirtyDrafts.has(manualScope)) {
    const next = { version: 2 as const, scope: manualScope, activeId, drafts };
    const pending = dirtyDrafts.get(manualScope);
    if (!persistCollection(next, storage)) throw new Error(migrationError);
    if (unresolvedManualIds.size && pending && manual) {
      for (const id of pending.keys()) {
        if (!unresolvedManualIds.has(id)) pending.delete(id);
      }
      dirtyDrafts.set(manualScope, pending);
      const unresolved = manual.drafts.filter(draft => unresolvedManualIds.has(draft.id));
      cacheCollection({ ...next, drafts: [...drafts.filter(draft => !unresolvedManualIds.has(draft.id)), ...unresolved] });
    } else {
      cacheCollection(next);
    }
    expectedManual = JSON.stringify(next);
  }

  // Leave ordinary v2 in place if cleanup is pending, so reads won't fall
  // back to an unresolved v1 while the migrated drafts remain available.
  const remaining = withoutDrafts(ordinary, migratedIds);
  try {
    if (storage.getItem(manualKey) !== expectedManual || storage.getItem(ordinaryKey) !== expectedOrdinary) return;
    if (!cleanupLegacyDraft(scopes.ordinary, storage, [...added, ...(remaining?.drafts ?? [])], scopes.manual)) return;
    if (storage.getItem(ordinaryKey) !== expectedOrdinary) return;
  } catch { return; }
  try {
    const canSaveRemaining = !remaining || parsePracticeDraftCollection(remaining, scopes.ordinary) !== null;
    let durableRemaining = remaining;
    if (!canSaveRemaining) {
      // A conflicting edit stays in memory. Remove only the migrated IDs from the stored source.
      durableRemaining = source ? withoutDrafts(source.collection, migratedIds) : null;
      if (durableRemaining && !parsePracticeDraftCollection(durableRemaining, scopes.ordinary)) throw new Error(migrationError);
    }
    if (durableRemaining) storage.setItem(ordinaryKey, JSON.stringify(durableRemaining));
    else storage.removeItem(ordinaryKey);

    const pending = dirtyDrafts.get(scopes.ordinary);
    if (!canSaveRemaining) {
      for (const id of migratedIds) pending?.delete(id);
    }
    if (canSaveRemaining || !pending?.size) dirtyDrafts.delete(scopes.ordinary);
    unreconciled.delete(scopes.ordinary);
    if (remaining) cacheCollection(remaining);
    else forgetCollection(scopes.ordinary);
  } catch (reason) {
    if (!manualEntry) throw reason;
  }
}

export function readPartitionedPracticeDraftCollection(scopes: PracticeDraftScopes, fallback: PracticeDraft, storage: PartitionStorage | null): PracticeDraftCollection | null {
  if (storage) {
    let ordinary: StoredPracticeDraftCollection | null = null;
    const unsavedOrdinary = dirtyDrafts.has(scopes.ordinary);
    const previousBlocked = blocked.get(scopes.ordinary);
    let ordinaryReadSucceeded = false;
    try {
      // Revalidate on every migration attempt, including after an interrupted cleanup.
      ordinary = readStoredPracticeDraftCollection(scopes.ordinary, storage);
      ordinaryReadSucceeded = true;
      if (!unsavedOrdinary) {
        unreconciled.delete(scopes.ordinary);
        if (ordinary) cacheCollection(ordinary.collection);
        else forgetCollection(scopes.ordinary);
      }
    } catch (reason) {
      if (unsavedOrdinary && memory.has(scopes.ordinary)) {
        unreconciled.add(scopes.ordinary);
        if (previousBlocked === undefined) blocked.delete(scopes.ordinary);
        else blocked.set(scopes.ordinary, previousBlocked);
        if (fallback.scope !== scopes.manual && memory.get(scopes.ordinary)!.drafts.some(draft => draft.fields.matrixMode !== true)) {
          throw reason;
        }
      } else {
        forgetCollection(scopes.ordinary);
        if (fallback.scope !== scopes.manual) throw reason;
      }
    }
    if (ordinaryReadSucceeded && unsavedOrdinary && memory.has(scopes.ordinary)) {
      const cached = memory.get(scopes.ordinary)!;
      const storedDrafts = ordinary?.collection.drafts ?? [];
      const storedManualActive = storedDrafts.find(draft => draft.id === ordinary?.collection.activeId && draft.fields.matrixMode !== true)?.id;
      const reconciled = mergeWithStoredCollection(scopes.ordinary, cached, ordinary, undefined, storedManualActive);
      if (!reconciled) {
        forgetCollection(scopes.ordinary);
        dirtyDrafts.delete(scopes.ordinary);
        unreconciled.delete(scopes.ordinary);
      } else {
        if (reconciled.drafts.some(draft => draft.fields.matrixMode !== true)) {
          unreconciled.add(scopes.ordinary);
          migrateOrdinaryManualDrafts(scopes, reconciled, ordinary, fallback, storage);
        } else {
          cacheCollection(reconciled);
          unreconciled.delete(scopes.ordinary);
          persistCollection(reconciled, storage);
        }
      }
    } else if (!unsavedOrdinary && ordinary?.collection.drafts.some(draft => draft.fields.matrixMode !== true)) {
      migrateOrdinaryManualDrafts(scopes, ordinary.collection, ordinary, fallback, storage);
    }
  } else if (fallback.scope !== scopes.manual && readPracticeDraftCollection(scopes.ordinary, null)?.drafts.some(draft => draft.fields.matrixMode !== true)) {
    throw new Error("无法迁移练习草稿，原答案已保留。请允许此页面使用浏览器存储后重试。");
  }
  const collection = readPracticeDraftCollection(fallback.scope, storage);
  if (fallback.scope !== scopes.manual || !collection) return collection;

  const active = collection.drafts.find(draft => draft.id === collection.activeId)!;
  if (isRecoverableManualDraft(active)) return collection;
  // Saved answers belong to course history. Keep unfinished archives available on the shelf.
  return switchPracticeDraft(scopes.manual, active.id, emptyPracticeDraft(scopes.manual, fallback.fields), storage);
}

export function practiceDraftHasUnsavedStorage(scope: string): boolean { return dirtyDrafts.has(scope); }

export function assertPracticeDraftSaved(scope: string): void {
  if (dirtyDrafts.has(scope) || unreconciled.has(scope)) throw new Error("原答案和请求尚未成功保存到浏览器，已暂停发送。请先复制答案或释放浏览器存储后重试。");
}

function mergeWithStoredCollection(
  scope: string,
  cached: PracticeDraftCollection,
  stored: StoredPracticeDraftCollection | null,
  extraEditedIds?: ReadonlySet<string>,
  explicitActiveId?: string,
): PracticeDraftCollection | null {
  const edits = dirtyDrafts.get(scope);
  const isEdited = (id: string) => Boolean(edits?.has(id) || extraEditedIds?.has(id));
  const storedDrafts = stored?.collection.drafts ?? [];
  const storedIds = new Set(storedDrafts.map(value => value.id));
  const mergedDrafts = [
    ...storedDrafts.map(value => {
      const patch = edits?.get(value.id)?.patch;
      return patch ? applyDraftPatch(value, patch) : value;
    }),
    ...cached.drafts.filter(value => !storedIds.has(value.id) && isEdited(value.id)),
  ];
  const first = mergedDrafts[0];
  if (!first) return null;
  const includes = (id: string) => mergedDrafts.some(value => value.id === id);
  const activeId = explicitActiveId && includes(explicitActiveId)
    ? explicitActiveId
    : (isEdited(cached.activeId) && includes(cached.activeId)
      ? cached.activeId
      : stored?.collection.activeId ?? first.id);
  return { version: 2, scope, activeId, drafts: mergedDrafts };
}

function saveDraftEdit(
  current: PracticeDraft,
  change: (base: PracticeDraft) => DraftPatch,
  storage: WriteStorage | null,
  snapshot?: PracticeDraft,
) {
  const { scope, id } = current;
  const error = blocked.get(scope);
  if (error) throw new Error(error);
  const collection = memory.get(scope) ?? { version: 2 as const, scope, activeId: id, drafts: [] };
  const previousBlocked = blocked.get(scope);
  const readable = isReadStorage(storage);
  let stored: StoredPracticeDraftCollection | null = null;
  let readFailed = false;
  if (readable) {
    try {
      // This edit already has a local identity. A fresh v1 read must not replace its snapshot.
      stored = readStoredPracticeDraftCollection(scope, storage, true);
    } catch {
      readFailed = true;
    }
  }
  const edits = dirtyDrafts.get(scope) ?? new Map<string, PendingDraftEdit>();
  const previous = edits.get(id) ?? { patch: {}, written: {} };
  const clean = snapshot && cleanBase.get(scope)?.drafts.find(value => value.id === id);
  // An unchanged snapshot field cancels our own failed full write. A patch
  // from another caller, or a newer durable value, still takes precedence.
  const reverted = clean && snapshot ? omitDraftPatchKeys(previous.written, draftChanges(clean, snapshot)) : {};
  const pending = omitDraftPatchKeys(previous.patch, reverted);
  const live = stored?.collection.drafts.find(value => value.id === id);
  const base = live ? applyDraftPatch(live, pending) : applyDraftPatch(current, revertedToSnapshot(reverted, snapshot));
  const patch = change(base);
  const draft = applyDraftPatch(base, patch);
  const found = collection.drafts.some(value => value.id === id);
  let next = { ...collection, drafts: found ? collection.drafts.map(value => value.id === id ? draft : value) : [...collection.drafts, draft] };
  // Keep the latest inputs in this document even if the browser refuses persistence.
  memory.set(scope, next);
  edits.set(id, {
    patch: combineDraftPatches(pending, patch),
    written: snapshot
      ? combineDraftPatches(omitDraftPatchKeys(previous.written, reverted), patch)
      : omitDraftPatchKeys(previous.written, patch),
  });
  dirtyDrafts.set(scope, edits);
  if (readFailed) {
    restoreCachedReadFailure(scope, previousBlocked);
    return { draft, persisted: false };
  }
  if (readable) {
    next = mergeWithStoredCollection(scope, next, stored)!;
    memory.set(scope, next);
    unreconciled.delete(scope);
  }
  return { draft, persisted: persistCollection(next, storage) };
}

function revertedToSnapshot(reverted: DraftPatch, snapshot: PracticeDraft | undefined): DraftPatch {
  if (!snapshot) return {};
  const { fields, ...checkpoint } = snapshot;
  const { fields: revertedFields, ...revertedCheckpoint } = reverted;
  function pick<T extends object>(value: T, keys: object): Partial<T> {
    const selected: Partial<T> = {};
    for (const key of Object.keys(keys) as (keyof T)[]) selected[key] = value[key];
    return selected;
  }
  return { ...pick(checkpoint, revertedCheckpoint), fields: pick(fields, revertedFields ?? {}) };
}

function changedProperties<T extends object>(previous: T, next: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) patch[key] = next[key];
  }
  return patch;
}

function draftChanges(base: PracticeDraft | null, draft: PracticeDraft): DraftPatch {
  const { start, attemptId, observationId, submission, disputeKey, fields } = draft;
  const checkpoint = { start, attemptId, observationId, submission, disputeKey };
  return base ? { ...changedProperties(base, checkpoint), fields: changedProperties(base.fields, fields) } : { ...checkpoint, fields };
}

export function writePracticeDraft(draft: PracticeDraft, storage: WriteStorage | null, base = cleanBase.get(draft.scope)?.drafts.find(value => value.id === draft.id) ?? null): boolean {
  const cached = memory.get(draft.scope)?.drafts.find(value => value.id === draft.id);
  return saveDraftEdit(cached ?? draft, () => draftChanges(base, draft), storage, draft).persisted;
}

/** Every callback uses its captured draftId, including after another draft becomes active. */
export function patchPracticeDraft(scope: string, initial: Partial<PracticeFields>, change: DraftPatch | ((current: PracticeDraft) => DraftPatch), storage: WriteStorage | null, draftId?: string) {
  const collection = memory.get(scope) ?? initializePracticeDraft(emptyPracticeDraft(scope, initial));
  const current = collection.drafts.find(value => value.id === (draftId ?? collection.activeId));
  if (!current) throw new Error("原练习草稿不可用，未修改其他草稿。");
  return saveDraftEdit(current, typeof change === "function" ? change : () => change, storage);
}

/** Save the complete old/new set in one operation before changing the active identity. */
export function switchPracticeDraft(scope: string, expectedActiveId: string, target: PracticeDraft | string, storage: WriteStorage | null): PracticeDraftCollection {
  const current = memory.get(scope);
  if (!current || current.activeId !== expectedActiveId) throw new Error("当前草稿已切换，请使用当前页面的操作。");
  const newDraft = typeof target === "string" ? null : target;
  const targetId = typeof target === "string" ? target : target.id;
  const invalidDraft = "新草稿身份无效，当前答案未改动。";
  const switchError = "未能保存全部草稿，已取消切换；当前原答案和请求仍保留。请先复制答案或释放浏览器存储后重试。";
  if (newDraft && (newDraft.scope !== scope || current.drafts.some(value => value.id === targetId))) {
    throw new Error(invalidDraft);
  }
  const drafts = newDraft ? [...current.drafts, newDraft] : current.drafts;
  let next: PracticeDraftCollection | null = { ...current, activeId: targetId, drafts };
  if (isReadStorage(storage)) {
    const previousBlocked = blocked.get(scope);
    let stored: StoredPracticeDraftCollection | null;
    try {
      stored = readStoredPracticeDraftCollection(scope, storage);
    } catch {
      restoreCachedReadFailure(scope, previousBlocked);
      throw new Error(switchError);
    }
    unreconciled.delete(scope);
    if (newDraft && stored?.collection.drafts.some(value => value.id === targetId)) throw new Error(invalidDraft);
    const extraIds = new Set<string>();
    if (newDraft) extraIds.add(targetId);
    // The first switch can archive an initialized draft that has never been written.
    if (initializedCollections.has(current) && !stored?.collection.drafts.some(value => value.id === current.activeId)) {
      extraIds.add(current.activeId);
    }
    next = mergeWithStoredCollection(scope, next, stored, extraIds, targetId);
  }
  if (!next?.drafts.some(value => value.id === targetId)) throw new Error("找不到这份保留的草稿，当前答案未改动。");
  if (!persistCollection(next, storage)) throw new Error(switchError);
  return cacheCollection(next);
}

/** Hide a moved archive while its destination owns the active draft, and retry safe cleanup. */
export function reconcileMovedPracticeArchives(
  collection: PracticeDraftCollection, targetScopeFor: (draft: PracticeDraft) => string, storage: PartitionStorage | null,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (!storage) return hidden;
  const { scope, activeId, drafts } = collection;
  for (const draft of drafts) {
    if (draft.id === activeId) continue;
    const targetScope = targetScopeFor(draft);
    if (targetScope === scope) continue;
    try {
      const raw = storage.getItem(storageKey(targetScope));
      const target = raw === null ? null : parsePracticeDraftCollection(JSON.parse(raw), targetScope);
      if (target?.activeId !== draft.id) continue;
      // After a reload, identical persisted copies also identify an interrupted move.
      const moved = target.drafts.find(value => value.id === draft.id);
      const sameCopy = JSON.stringify(moved) === JSON.stringify(parsePracticeDraft({ ...draft, scope: targetScope }, targetScope));
      const pending = pendingArchiveCleanup.get(draft.id);
      const unchangedSource = pending?.targetScope === targetScope
        && JSON.stringify(pending.source) === JSON.stringify(parsePracticeDraft(draft, scope));
      if (!sameCopy && !unchangedSource) continue;
      hidden.add(draft.id);
    } catch { /* An unreadable destination cannot prove a move. */ }
  }
  if (!hidden.size || dirtyDrafts.has(scope)) return hidden;
  try {
    const key = storageKey(scope);
    const raw = storage.getItem(key);
    const saved = raw === null ? null : parsePracticeDraftCollection(JSON.parse(raw), scope);
    if (!saved) return new Set();
    const cached = parsePracticeDraftCollection(collection, scope);
    if (JSON.stringify(saved) !== JSON.stringify(cached)) {
      // An editor can save a new answer into a source we already loaded.
      // Refresh the clean cache and only keep proofs for unchanged archives.
      for (const id of hidden) {
        const previous = cached?.drafts.find(draft => draft.id === id);
        const live = saved.drafts.find(draft => draft.id === id);
        if (!live || live.id === saved.activeId || JSON.stringify(live) !== JSON.stringify(previous)) hidden.delete(id);
      }
      if (memory.get(scope) === collection) cacheCollection(saved);
      return hidden;
    }
    const next = { ...collection, drafts: drafts.filter(draft => !hidden.has(draft.id)) };
    storage.setItem(key, JSON.stringify(next));
    cacheCollection(next);
    for (const id of hidden) pendingArchiveCleanup.delete(id);
  } catch { /* Keep the source archive until cleanup can be saved. */ }
  return hidden;
}

/** Promote an archive in the collection the destination URL will reopen. */
export function moveArchivedPracticeDraft(
  scope: string, expectedActiveId: string, draftId: string, targetScope: string, storage: PartitionStorage | null,
): PracticeDraftCollection {
  const moveError = "草稿未切换，原答案已保留。请允许使用浏览器存储或释放空间后重试。";
  const current = memory.get(scope);
  if (!storage || !current || current.activeId !== expectedActiveId || draftId === expectedActiveId || scope === targetScope) {
    throw new Error(moveError);
  }

  const previousSourceBlocked = blocked.get(scope);
  let storedSource: StoredPracticeDraftCollection | null;
  try {
    storedSource = readStoredPracticeDraftCollection(scope, storage);
  } catch {
    restoreCachedReadFailure(scope, previousSourceBlocked);
    throw new Error(moveError);
  }
  const source = mergeWithStoredCollection(scope, current, storedSource);
  if (!source || source.activeId !== expectedActiveId) throw new Error(moveError);
  const archived = source.drafts.find(draft => draft.id === draftId);
  if (!archived) throw new Error(moveError);
  const moved = parsePracticeDraft({ ...archived, scope: targetScope }, targetScope);
  if (!moved) throw new Error(moveError);

  const targetKey = storageKey(targetScope);
  const previousTargetBlocked = blocked.get(targetScope);
  let previousTarget: string | null;
  let storedTarget: StoredPracticeDraftCollection | null;
  try {
    previousTarget = storage.getItem(targetKey);
    storedTarget = readStoredPracticeDraftCollection(targetScope, storage);
  } catch {
    restoreCachedReadFailure(targetScope, previousTargetBlocked);
    throw new Error(moveError);
  }
  const cachedTarget = memory.get(targetScope);
  const target = cachedTarget && dirtyDrafts.has(targetScope)
    ? mergeWithStoredCollection(targetScope, cachedTarget, storedTarget)
    : storedTarget?.collection;
  const targetDrafts = target?.drafts ?? [];
  const existing = targetDrafts.find(draft => draft.id === draftId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(moved)) throw new Error(moveError);

  const nextTarget: PracticeDraftCollection = {
    version: 2, scope: targetScope, activeId: draftId,
    drafts: existing ? targetDrafts : [...targetDrafts, moved],
  };
  if (!parsePracticeDraftCollection(nextTarget, targetScope)) throw new Error(moveError);
  const nextSource = { ...source, drafts: source.drafts.filter(draft => draft.id !== draftId) };

  // Rollback can fail after the destination is saved. First make the source
  // answer durable with the archive still in place, so either outcome can reopen.
  if (dirtyDrafts.has(scope) || JSON.stringify(source) !== JSON.stringify(storedSource?.collection)) {
    unreconciled.delete(scope);
    if (!persistCollection(source, storage)) throw new Error(moveError);
  }
  cacheCollection(source);

  try {
    storage.setItem(targetKey, JSON.stringify(nextTarget));
  } catch { throw new Error(moveError); }

  let sourceSaved = false;
  try {
    storage.setItem(storageKey(scope), JSON.stringify(nextSource));
    pendingArchiveCleanup.delete(draftId);
    sourceSaved = true;
  } catch {
    let rolledBack = false;
    try {
      if (previousTarget === null) storage.removeItem(targetKey);
      else storage.setItem(targetKey, previousTarget);
      rolledBack = true;
    } catch {
      // The destination is durable. Leave the source selection and archive intact for cleanup on reopen.
      pendingArchiveCleanup.set(draftId, { source: parsePracticeDraft(archived, scope)!, targetScope });
    }
    if (rolledBack) throw new Error(moveError);
  }

  for (const saved of sourceSaved ? [nextSource, nextTarget] : [nextTarget]) {
    cacheCollection(saved);
    unreconciled.delete(saved.scope);
    finishCollectionSave(saved, storage);
  }
  return nextTarget;
}
