import { z } from "zod";
import { emptyGradingPhoto, type GradingPhotoSelection } from "./ai-grading-photo";

const schema = z.object({ workSourceId: z.string().uuid(), workSourceVersion: z.number().int().positive(), physicalPage: z.number().int().positive() }).strict();
const memory = new Map<string, GradingPhotoSelection>();
const key = (observationId: string) => `study:grading-photo:v1:${observationId}`;

/** Browser data is a selection only, never proof that grading succeeded. */
export function readGradingPhotoDraft(observationId: string): GradingPhotoSelection {
  try {
    const raw = typeof window !== "undefined" ? window.sessionStorage.getItem(key(observationId)) : null;
    if (raw) {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) { memory.set(observationId, parsed.data); return parsed.data; }
    }
  } catch { /* Use the same-document selection when storage is unavailable. */ }
  return memory.get(observationId) ?? emptyGradingPhoto;
}

export function saveGradingPhotoDraft(observationId: string, value: GradingPhotoSelection): boolean {
  memory.set(observationId, value);
  try {
    if (typeof window === "undefined") return false;
    if (value.workSourceId) window.sessionStorage.setItem(key(observationId), JSON.stringify(value));
    else window.sessionStorage.removeItem(key(observationId));
    return true;
  } catch { return false; }
}
