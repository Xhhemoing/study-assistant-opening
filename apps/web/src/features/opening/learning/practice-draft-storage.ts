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
const memory = new Map<string, PracticeDraftCollection>();
const dirty = new Set<string>();
const dirtyDraftIds = new Map<string, Set<string>>();
const legacyIds = new Map<string, { raw: string; id: string }>();
const loadedFromLegacy = new Set<string>();
const unreconciled = new Set<string>();
const blocked = new Map<string, string>();

function markDirtyDraft(scope: string, draftId: string): void {
  let ids = dirtyDraftIds.get(scope);
  if (!ids) { ids = new Set(); dirtyDraftIds.set(scope, ids); }
  ids.add(draftId);
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
type StoredPracticeDraftCollection = { collection: PracticeDraftCollection; legacy: boolean };

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

function readStoredPracticeDraftCollection(scope: string, storage: ReadStorage): StoredPracticeDraftCollection | null {
  function unreadable(message: string): never { blocked.set(scope, message); throw new Error(message); }
  let raw: string | null;
  let legacy = false;
  try {
    raw = storage.getItem(storageKey(scope));
    if (raw === null) { raw = storage.getItem(legacyStorageKey(scope)); legacy = true; }
  } catch { unreadable("无法读取练习草稿，已停止新建和切换。请允许此页面使用浏览器存储后重试。"); }
  if (raw === null) {
    blocked.delete(scope);
    if (!dirty.has(scope)) {
      legacyIds.delete(scope);
      loadedFromLegacy.delete(scope);
    }
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { unreadable("保存的练习草稿无法解析，原内容未改动。请恢复浏览器存储后重试。"); }
  let collection: PracticeDraftCollection | null;
  if (legacy) {
    const hasExplicitId = typeof (parsed as { id?: unknown } | null)?.id === "string";
    const parsedDraft = parsePracticeDraft(parsed, scope);
    if (parsedDraft) {
      let draft = parsedDraft;
      if (!hasExplicitId) {
        const remembered = legacyIds.get(scope);
        const id = remembered && remembered.raw === raw ? remembered.id : parsedDraft.id;
        legacyIds.set(scope, { raw, id });
        draft = { ...parsedDraft, id };
      } else legacyIds.delete(scope);
      collection = { version: 2, scope, activeId: draft.id, drafts: [draft] };
    } else collection = null;
  } else {
    collection = parsePracticeDraftCollection(parsed, scope);
  }
  if (!collection) unreadable("保存的练习草稿身份或内容无效，原内容未改动，已停止新建和切换。");
  if (legacy) loadedFromLegacy.add(scope);
  else {
    legacyIds.delete(scope);
    if (loadedFromLegacy.has(scope)) {
      try {
        if (storage.getItem(legacyStorageKey(scope)) === null) loadedFromLegacy.delete(scope);
      } catch {
        // Keep legacy cleanup pending until the legacy key is removed or confirmed absent.
      }
    }
  }
  blocked.delete(scope);
  return { collection, legacy };
}

/** A bad stored checkpoint blocks new writes; it is never silently replaced by an empty draft. */
export function readPracticeDraftCollection(scope: string, storage: ReadStorage | null): PracticeDraftCollection | null {
  const cached = memory.get(scope);
  if (cached) return cached;
  if (!storage) {
    const error = blocked.get(scope);
    if (error) throw new Error(error);
    return null;
  }
  const stored = readStoredPracticeDraftCollection(scope, storage);
  if (!stored) return null;
  memory.set(scope, stored.collection);
  return stored.collection;
}

export function initializePracticeDraft(draft: PracticeDraft): PracticeDraftCollection {
  const error = blocked.get(draft.scope);
  if (error) throw new Error(error);
  const collection = memory.get(draft.scope) ?? { version: 2 as const, scope: draft.scope, activeId: draft.id, drafts: [draft] };
  memory.set(draft.scope, collection);
  return collection;
}

export function readPracticeDraft(scope: string, storage: ReadStorage | null, draftId?: string): PracticeDraft | null {
  const collection = readPracticeDraftCollection(scope, storage);
  return collection?.drafts.find(draft => draft.id === (draftId ?? collection.activeId)) ?? null;
}

function persistCollection(collection: PracticeDraftCollection, storage: WriteStorage | null): boolean {
  if (unreconciled.has(collection.scope)) {
    dirty.add(collection.scope);
    return false;
  }
  try {
    if (!storage) throw new Error("storage unavailable");
    storage.setItem(storageKey(collection.scope), JSON.stringify(collection));
    dirty.delete(collection.scope);
    dirtyDraftIds.delete(collection.scope);
    if (loadedFromLegacy.has(collection.scope) && hasRemoveItem(storage)) {
      try {
        storage.removeItem(legacyStorageKey(collection.scope));
        legacyIds.delete(collection.scope);
        loadedFromLegacy.delete(collection.scope);
      } catch { /* v2 is already durable */ }
    }
    return true;
  } catch { dirty.add(collection.scope); return false; }
}

export type PracticeDraftScopes = { ordinary: string; manual: string };

export function isRecoverableManualDraft(draft: PracticeDraft): boolean {
  return draft.fields.matrixMode !== true && !draft.observationId;
}

function migrateOrdinaryManualDrafts(scopes: PracticeDraftScopes, source: StoredPracticeDraftCollection, fallback: PracticeDraft, storage: PartitionStorage): void {
  const { collection: ordinary, legacy } = source;
  const manualEntry = fallback.scope === scopes.manual;
  const manual = readPracticeDraftCollection(scopes.manual, storage);
  const moved = ordinary.drafts.filter(draft => draft.fields.matrixMode !== true);
  const existingIds = new Set(manual?.drafts.map(draft => draft.id));
  const added = moved.filter(draft => !existingIds.has(draft.id)).map(draft => ({ ...draft, scope: scopes.manual }));
  const drafts = [...(manual?.drafts ?? []), ...added];
  const legacyActive = added.find(draft => draft.id === ordinary.activeId && isRecoverableManualDraft(draft));
  const manualFallback = manualEntry ? fallback : emptyPracticeDraft(scopes.manual);
  const activeId = manual?.activeId ?? legacyActive?.id ?? manualFallback.id;
  if (activeId === manualFallback.id && !drafts.some(draft => draft.id === activeId)) drafts.push(manualFallback);
  const migrationError = "无法迁移练习草稿，原答案已保留。请释放浏览器存储后重试。";

  // A v1 draft can lack an ID. Save the assigned ID before copying so a retry can recognize it.
  if (legacy) {
    try {
      storage.setItem(storageKey(scopes.ordinary), JSON.stringify(ordinary));
      memory.set(scopes.ordinary, ordinary);
    } catch {
      if (manualEntry && manual) return;
      throw new Error(migrationError);
    }
  }
  if (!manual || added.length || dirty.has(scopes.manual)) {
    const next = { version: 2 as const, scope: scopes.manual, activeId, drafts };
    if (!persistCollection(next, storage)) throw new Error(migrationError);
    memory.set(scopes.manual, next);
  }

  // Remove the source only after the destination is durable. A retry keeps the existing copy by ID.
  try {
    const oldKey = legacyStorageKey(scopes.ordinary);
    if (legacy) { storage.removeItem(oldKey); legacyIds.delete(scopes.ordinary); }
    else {
      const oldRaw = storage.getItem(oldKey);
      if (oldRaw !== null) {
        if (!parsePracticeDraft(JSON.parse(oldRaw), scopes.ordinary)) throw new Error(migrationError);
        storage.removeItem(oldKey);
        legacyIds.delete(scopes.ordinary);
      }
    }
    const matrixDrafts = ordinary.drafts.filter(draft => draft.fields.matrixMode === true);
    if (matrixDrafts.length) {
      const active = matrixDrafts.find(draft => draft.id === ordinary.activeId) ?? matrixDrafts[0]!;
      const remaining = { ...ordinary, activeId: active.id, drafts: matrixDrafts };
      storage.setItem(storageKey(scopes.ordinary), JSON.stringify(remaining));
      memory.set(scopes.ordinary, remaining);
      dirty.delete(scopes.ordinary);
      dirtyDraftIds.delete(scopes.ordinary);
      unreconciled.delete(scopes.ordinary);
    } else {
      storage.removeItem(storageKey(scopes.ordinary));
      memory.delete(scopes.ordinary);
      dirty.delete(scopes.ordinary);
      dirtyDraftIds.delete(scopes.ordinary);
      unreconciled.delete(scopes.ordinary);
    }
  } catch (reason) {
    if (!manualEntry) throw reason;
  }
}

export function readPartitionedPracticeDraftCollection(scopes: PracticeDraftScopes, fallback: PracticeDraft, storage: PartitionStorage | null): PracticeDraftCollection | null {
  if (storage) {
    let ordinary: StoredPracticeDraftCollection | null = null;
    const unsavedOrdinary = dirty.has(scopes.ordinary);
    const previousBlocked = blocked.get(scopes.ordinary);
    let ordinaryReadSucceeded = false;
    try {
      // Revalidate on every migration attempt, including after an interrupted cleanup.
      ordinary = readStoredPracticeDraftCollection(scopes.ordinary, storage);
      ordinaryReadSucceeded = true;
      if (!unsavedOrdinary) {
        dirtyDraftIds.delete(scopes.ordinary);
        unreconciled.delete(scopes.ordinary);
        if (ordinary) memory.set(scopes.ordinary, ordinary.collection);
        else memory.delete(scopes.ordinary);
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
        memory.delete(scopes.ordinary);
        if (fallback.scope !== scopes.manual) throw reason;
      }
    }
    if (ordinaryReadSucceeded && unsavedOrdinary && memory.has(scopes.ordinary)) {
      const cached = memory.get(scopes.ordinary)!;
      const editedIds = dirtyDraftIds.get(scopes.ordinary);
      const isLocallyEdited = (id: string) => Boolean(editedIds?.has(id));
      const cachedById = new Map(cached.drafts.map(draft => [draft.id, draft]));
      const storedDrafts = ordinary?.collection.drafts ?? [];
      const storedIds = new Set(storedDrafts.map(draft => draft.id));
      const mergedDrafts = [
        ...storedDrafts.map(draft => (isLocallyEdited(draft.id) ? cachedById.get(draft.id) : undefined) ?? draft),
        ...cached.drafts.filter(draft => !storedIds.has(draft.id) && isLocallyEdited(draft.id)),
      ];
      if (mergedDrafts.length === 0) {
        memory.delete(scopes.ordinary);
        dirty.delete(scopes.ordinary);
        dirtyDraftIds.delete(scopes.ordinary);
        unreconciled.delete(scopes.ordinary);
      } else {
        const storedManualActive = storedDrafts.find(draft => draft.id === ordinary?.collection.activeId && draft.fields.matrixMode !== true)?.id;
        const preferredActive = storedManualActive
          ?? (isLocallyEdited(cached.activeId) && mergedDrafts.some(draft => draft.id === cached.activeId)
            ? cached.activeId
            : (ordinary?.collection.activeId && mergedDrafts.some(draft => draft.id === ordinary.collection.activeId)
              ? ordinary.collection.activeId
              : mergedDrafts[0]!.id));
        const reconciled = { version: 2 as const, scope: scopes.ordinary, activeId: preferredActive, drafts: mergedDrafts };
        if (reconciled.drafts.some(draft => draft.fields.matrixMode !== true)) {
          unreconciled.add(scopes.ordinary);
          migrateOrdinaryManualDrafts(scopes, { collection: reconciled, legacy: Boolean(ordinary?.legacy) }, fallback, storage);
        } else {
          memory.set(scopes.ordinary, reconciled);
          unreconciled.delete(scopes.ordinary);
          if (persistCollection(reconciled, storage)) {
            try {
              const oldKey = legacyStorageKey(scopes.ordinary);
              if (ordinary?.legacy || loadedFromLegacy.has(scopes.ordinary)) {
                storage.removeItem(oldKey);
                legacyIds.delete(scopes.ordinary);
                loadedFromLegacy.delete(scopes.ordinary);
              } else {
                const oldRaw = storage.getItem(oldKey);
                if (oldRaw !== null && parsePracticeDraft(JSON.parse(oldRaw), scopes.ordinary)) {
                  storage.removeItem(oldKey);
                  legacyIds.delete(scopes.ordinary);
                }
              }
            } catch { /* v2 already authoritative */ }
          }
        }
      }
    } else if (!unsavedOrdinary && ordinary?.collection.drafts.some(draft => draft.fields.matrixMode !== true)) {
      migrateOrdinaryManualDrafts(scopes, ordinary, fallback, storage);
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

export function practiceDraftHasUnsavedStorage(scope: string): boolean { return dirty.has(scope); }

export function assertPracticeDraftSaved(scope: string): void {
  if (dirty.has(scope)) throw new Error("原答案和请求尚未成功保存到浏览器，已暂停发送。请先复制答案或释放浏览器存储后重试。");
}

function mergeWithStoredCollection(
  scope: string,
  cached: PracticeDraftCollection,
  stored: StoredPracticeDraftCollection | null,
  extraEditedIds?: ReadonlySet<string>,
  explicitActiveId?: string,
): PracticeDraftCollection {
  const editedIds = dirtyDraftIds.get(scope);
  const isEdited = (id: string) => Boolean(editedIds?.has(id) || extraEditedIds?.has(id));
  const cachedById = new Map(cached.drafts.map(value => [value.id, value]));
  const storedDrafts = stored?.collection.drafts ?? [];
  const storedIds = new Set(storedDrafts.map(value => value.id));
  const mergedDrafts = [
    ...storedDrafts.map(value => (isEdited(value.id) ? cachedById.get(value.id) : undefined) ?? value),
    ...cached.drafts.filter(value => !storedIds.has(value.id) && isEdited(value.id)),
  ];
  const activeId = explicitActiveId && mergedDrafts.some(value => value.id === explicitActiveId)
    ? explicitActiveId
    : (isEdited(cached.activeId) && mergedDrafts.some(value => value.id === cached.activeId)
      ? cached.activeId
      : (stored?.collection.activeId && mergedDrafts.some(value => value.id === stored.collection.activeId)
        ? stored.collection.activeId
        : (mergedDrafts.some(value => value.id === cached.activeId) ? cached.activeId : mergedDrafts[0]!.id)));
  return { version: 2, scope, activeId, drafts: mergedDrafts };
}

export function writePracticeDraft(draft: PracticeDraft, storage: WriteStorage | null): boolean {
  const error = blocked.get(draft.scope);
  if (error) throw new Error(error);
  const wasDirty = dirty.has(draft.scope);
  const collection = memory.get(draft.scope) ?? { version: 2 as const, scope: draft.scope, activeId: draft.id, drafts: [] };
  const found = collection.drafts.some(value => value.id === draft.id);
  let next: PracticeDraftCollection = {
    ...collection,
    drafts: found ? collection.drafts.map(value => value.id === draft.id ? draft : value) : [...collection.drafts, draft],
  };
  // Keep the latest inputs in this document even if the browser refuses persistence.
  memory.set(draft.scope, next);
  markDirtyDraft(draft.scope, draft.id);
  if (wasDirty && isReadStorage(storage)) {
    const previousBlocked = blocked.get(draft.scope);
    try {
      const stored = readStoredPracticeDraftCollection(draft.scope, storage);
      next = mergeWithStoredCollection(draft.scope, next, stored);
      memory.set(draft.scope, next);
      unreconciled.delete(draft.scope);
    } catch {
      if (previousBlocked === undefined) blocked.delete(draft.scope);
      else blocked.set(draft.scope, previousBlocked);
      unreconciled.add(draft.scope);
      dirty.add(draft.scope);
      return false;
    }
  }
  return persistCollection(next, storage);
}

export type DraftPatch = Partial<Omit<PracticeDraft, "scope" | "version" | "id" | "fields">> & { fields?: Partial<PracticeFields> };

/** Every callback uses its captured draftId, including after another draft becomes active. */
export function patchPracticeDraft(scope: string, initial: Partial<PracticeFields>, change: DraftPatch | ((current: PracticeDraft) => DraftPatch), storage: WriteStorage | null, draftId?: string) {
  const collection = memory.get(scope) ?? initializePracticeDraft(emptyPracticeDraft(scope, initial));
  const current = collection.drafts.find(value => value.id === (draftId ?? collection.activeId));
  if (!current) throw new Error("原练习草稿不可用，未修改其他草稿。");
  const changes = typeof change === "function" ? change(current) : change;
  const next = { ...current, ...changes, id: current.id, scope, version: 1 as const, fields: { ...current.fields, ...changes.fields } };
  return { draft: next, persisted: writePracticeDraft(next, storage) };
}

/** Save the complete old/new set in one operation before changing the active identity. */
export function switchPracticeDraft(scope: string, expectedActiveId: string, target: PracticeDraft | string, storage: WriteStorage | null): PracticeDraftCollection {
  const current = memory.get(scope);
  if (!current || current.activeId !== expectedActiveId) throw new Error("当前草稿已切换，请使用当前页面的操作。");
  let drafts = current.drafts;
  let targetId: string;
  if (typeof target === "string") {
    if (!drafts.some(value => value.id === target)) throw new Error("找不到这份保留的草稿，当前答案未改动。");
    targetId = target;
  } else {
    if (target.scope !== scope || drafts.some(value => value.id === target.id)) throw new Error("新草稿身份无效，当前答案未改动。");
    drafts = [...drafts, target]; targetId = target.id;
  }
  let next: PracticeDraftCollection = { ...current, activeId: targetId, drafts };
  if (dirty.has(scope) && isReadStorage(storage)) {
    const previousBlocked = blocked.get(scope);
    try {
      const stored = readStoredPracticeDraftCollection(scope, storage);
      const extraIds = typeof target === "string" ? undefined : new Set([target.id]);
      next = mergeWithStoredCollection(scope, next, stored, extraIds, targetId);
      if (!next.drafts.some(value => value.id === targetId)) throw new Error("找不到这份保留的草稿，当前答案未改动。");
      unreconciled.delete(scope);
    } catch (reason) {
      if (previousBlocked === undefined) blocked.delete(scope);
      else blocked.set(scope, previousBlocked);
      unreconciled.add(scope);
      dirty.add(scope);
      if (reason instanceof Error && reason.message.includes("找不到这份保留的草稿")) throw reason;
      throw new Error("未能保存全部草稿，已取消切换；当前原答案和请求仍保留。请先复制答案或释放浏览器存储后重试。");
    }
  }
  if (!persistCollection(next, storage)) throw new Error("未能保存全部草稿，已取消切换；当前原答案和请求仍保留。请先复制答案或释放浏览器存储后重试。");
  memory.set(scope, next);
  return next;
}
