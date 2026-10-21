import { z } from "zod";
import { inlineAttemptSubmissionCheckpointSchema } from "./inline-attempt-submission";
import { inlineAttemptPreparationCheckpointSchema } from "./inline-attempt-prepare";

const draftSchema = z.object({
  answer: z.string().max(20_000), skillLabel: z.string().max(200), prompt: z.string().max(100_000),
  submission: inlineAttemptSubmissionCheckpointSchema.optional(),
  preparation: inlineAttemptPreparationCheckpointSchema.optional(),
}).strict();
export type InlineAttemptDraft = z.infer<typeof draftSchema>;
export type InlineAttemptDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const identityKeySchema = z.tuple([z.string().uuid(), z.string().uuid(), z.string().regex(/^v[1-9]\d*$/)]);
const storagePrefix = "study:inline-attempt:v1:";
const documentDrafts = new Map<string, InlineAttemptDraft>();
let documentStorageUnavailable = false;

export function inlineAttemptIdentityKey(activityId: string, blockId: string, version: number): string {
  return `${activityId}:${blockId}:v${version}`;
}

/** A restored request must never silently move to another course or question. */
export function inlineAttemptDraftConflict(draft: InlineAttemptDraft | undefined, current: { courseId: string | null; prompt: string }): "prompt_changed" | "course_changed" | null {
  if (draft && draft.prompt !== current.prompt) return "prompt_changed";
  const request = draft?.submission ?? draft?.preparation;
  if (request && request.input.courseId !== current.courseId) return "course_changed";
  return null;
}

function readDraft(key: string, raw: string): InlineAttemptDraft | undefined {
  try {
    if (!identityKeySchema.safeParse(key.split(":")).success) return;
    const result = draftSchema.safeParse(JSON.parse(raw));
    if (!result.success) return;
    const draft = result.data;
    const submitted = draft.submission?.input;
    const prepared = draft.preparation?.input;
    if (prepared && (inlineAttemptIdentityKey(prepared.activityId, prepared.blockId, prepared.contentVersion) !== key
      || prepared.skillLabel !== draft.skillLabel || prepared.prompt !== draft.prompt || draft.submission)) return;
    if (submitted && (inlineAttemptIdentityKey(submitted.activityId, submitted.blockId, submitted.contentVersion) !== key
      || submitted.answer !== draft.answer || submitted.skillLabel !== draft.skillLabel || submitted.prompt !== draft.prompt)) return;
    return draft;
  } catch { return; } // Persisted browser data is an untrusted boundary.
}

/** Per-tab persistence, with a document-memory fallback when browser storage is denied. */
export function createInlineAttemptDrafts(suppliedStorage?: InlineAttemptDraftStorage | null) {
  const values = suppliedStorage === undefined ? documentDrafts : new Map<string, InlineAttemptDraft>();
  let storage: InlineAttemptDraftStorage | null = suppliedStorage ?? null;
  let unavailable = suppliedStorage === undefined && documentStorageUnavailable;
  if (!unavailable && suppliedStorage === undefined && typeof window !== "undefined") {
    try { storage = window.sessionStorage; } catch { unavailable = true; documentStorageUnavailable = true; }
  }
  function failStorage() { unavailable = true; storage = null; if (suppliedStorage === undefined) documentStorageUnavailable = true; }
  function syncAvailability() { if (suppliedStorage === undefined && documentStorageUnavailable) failStorage(); }
  function get(key: string) {
    syncAvailability();
    if (storage) {
      try {
        const raw = storage.getItem(storagePrefix + key);
        if (raw !== null) {
          const draft = readDraft(key, raw);
          if (draft) values.set(key, draft); else values.delete(key);
          return draft;
        }
      } catch { failStorage(); }
    }
    return values.get(key);
  }
  return {
    get,
    get unavailable() { syncAvailability(); return unavailable; },
    set(key: string, value: InlineAttemptDraft | null) {
      if (value) values.set(key, value); else values.delete(key);
      syncAvailability();
      if (storage) {
        try { if (value) storage.setItem(storagePrefix + key, JSON.stringify(value)); else storage.removeItem(storagePrefix + key); }
        catch { failStorage(); }
      }
    },
    previous(activityId: string, blockId: string, version: number) {
      const prefix = `${activityId}:${blockId}:v`;
      const current = inlineAttemptIdentityKey(activityId, blockId, version);
      const keys = new Set(values.keys());
      syncAvailability();
      if (storage) {
        try {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.startsWith(storagePrefix + prefix)) keys.add(key.slice(storagePrefix.length));
          }
        } catch { failStorage(); }
      }
      return [...keys].filter(key => key.startsWith(prefix) && key !== current)
        .flatMap(key => { const draft = get(key); return draft?.answer.trim() ? [[key, draft] as const] : []; });
    },
  };
}
