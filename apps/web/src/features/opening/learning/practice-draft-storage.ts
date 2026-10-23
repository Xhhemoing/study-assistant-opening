import { z } from "zod";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningSessionCreateInputSchema } from "@aistudy/contracts";

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
const blocked = new Map<string, string>();
const storageKey = (scope: string) => `opening-practice:v2:${scope}`;
type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function practiceScope(courseId: string, mode: "ordinary" | "matrix" | "span", retest?: { retestId: string; prompt: string; skillLabel: string; requirementKey?: string | null; retestActivityId?: string } | null, focus?: { skillLabel: string; requirementKey: string | null }, problem?: { sourceId: string; sourceVersion: number }): string {
  // Retest content/requirement changes never attach an older frozen request to a newer task.
  return JSON.stringify([courseId, mode, retest?.retestId ?? null, retest?.retestActivityId ?? null, retest?.requirementKey ?? null, retest?.skillLabel ?? null, retest?.prompt ?? null, ...(!retest && focus ? [focus.skillLabel, focus.requirementKey] : []), ...(!retest && problem ? [{ sourceId: problem.sourceId, sourceVersion: problem.sourceVersion }] : [])]);
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
  // The eighth span element identifies a new-evidence request. It is not the
  // ordinary practice focus pair (elements eight and nine).
  if (context.length === 8 && (context[1] !== "span" || !z.string().uuid().safeParse(context[7]).success)) return null;
  const [courseId, mode, retestId, , requirementKey] = context;
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
    } else if (mode === "ordinary") {
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

/** A bad stored checkpoint blocks new writes; it is never silently replaced by an empty draft. */
export function readPracticeDraftCollection(scope: string, storage: ReadStorage | null): PracticeDraftCollection | null {
  const cached = memory.get(scope);
  if (cached) return cached;
  if (!storage) {
    const error = blocked.get(scope);
    if (error) throw new Error(error);
    return null;
  }
  function unreadable(message: string): never { blocked.set(scope, message); throw new Error(message); }
  let raw: string | null;
  let legacy = false;
  try {
    raw = storage.getItem(storageKey(scope));
    if (raw === null) { raw = storage.getItem(`opening-practice:v1:${scope}`); legacy = true; }
  } catch { unreadable("无法读取练习草稿，已停止新建和切换。请允许此页面使用浏览器存储后重试。"); }
  if (raw === null) { blocked.delete(scope); return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { unreadable("保存的练习草稿无法解析，原内容未改动。请恢复浏览器存储后重试。"); }
  let collection: PracticeDraftCollection | null;
  if (legacy) {
    const draft = parsePracticeDraft(parsed, scope);
    collection = draft ? { version: 2, scope, activeId: draft.id, drafts: [draft] } : null;
  } else collection = parsePracticeDraftCollection(parsed, scope);
  if (!collection) unreadable("保存的练习草稿身份或内容无效，原内容未改动，已停止新建和切换。");
  blocked.delete(scope);
  memory.set(scope, collection);
  return collection;
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
  try {
    if (!storage) throw new Error("storage unavailable");
    storage.setItem(storageKey(collection.scope), JSON.stringify(collection));
    dirty.delete(collection.scope);
    return true;
  } catch { dirty.add(collection.scope); return false; }
}

export function practiceDraftHasUnsavedStorage(scope: string): boolean { return dirty.has(scope); }

export function assertPracticeDraftSaved(scope: string): void {
  if (dirty.has(scope)) throw new Error("原答案和请求尚未成功保存到浏览器，已暂停发送。请先复制答案或释放浏览器存储后重试。");
}

export function writePracticeDraft(draft: PracticeDraft, storage: WriteStorage | null): boolean {
  const error = blocked.get(draft.scope);
  if (error) throw new Error(error);
  const collection = memory.get(draft.scope) ?? { version: 2 as const, scope: draft.scope, activeId: draft.id, drafts: [] };
  const found = collection.drafts.some(value => value.id === draft.id);
  const next = { ...collection, drafts: found ? collection.drafts.map(value => value.id === draft.id ? draft : value) : [...collection.drafts, draft] };
  // Keep the latest inputs in this document even if the browser refuses persistence.
  memory.set(draft.scope, next);
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
  const next = { ...current, activeId: targetId, drafts };
  if (!persistCollection(next, storage)) throw new Error("未能保存全部草稿，已取消切换；当前原答案和请求仍保留。请先复制答案或释放浏览器存储后重试。");
  memory.set(scope, next);
  return next;
}
