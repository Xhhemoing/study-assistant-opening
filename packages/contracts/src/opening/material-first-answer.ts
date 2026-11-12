import { z } from "zod";
import { uuidSchema } from "./foundation";
import { teachingQuestionInteractionSchema } from "./teaching-activity";

const version = z.number().int().nonnegative().safe();
const locatorSchema = z.object({
  sourceId: uuidSchema,
  sourceVersion: version,
  /** Server-authorized prompt-only locator, never a chunk/page preview URL. */
  locatorId: uuidSchema,
}).strict();
const locatorsSchema = z.array(locatorSchema).max(8).refine(
  refs => new Set(refs.map(ref => ref.locatorId)).size === refs.length,
);
const publicationSchema = z.object({
  activityId: uuidSchema,
  courseId: uuidSchema,
  blockId: uuidSchema,
  revisionId: uuidSchema,
  contentVersion: version,
  mappingId: uuidSchema,
  bindingRevision: z.number().int().positive().safe(),
}).strict();
const presentationSchema = z.object({
  text: z.string().min(1).max(8000).refine(text => text.trim().length > 0),
  interaction: teachingQuestionInteractionSchema,
  sourceLocators: locatorsSchema,
}).strict();
const inputSchema = z.object({
  binding: z.object({
    mappingId: uuidSchema,
    revision: z.number().int().positive().safe(),
    sourceLocators: locatorsSchema,
  }).strict(),
  publication: publicationSchema,
  issuance: z.object({
    attemptId: uuidSchema,
    itemVersionId: uuidSchema,
    problemId: uuidSchema,
    publication: publicationSchema,
  }).strict(),
  presentation: presentationSchema,
}).strict();

/**
 * A shape for facts already checked by the server in the actual issuance boundary.
 * Structural typing/parsing does NOT authenticate them, issue/publish anything,
 * prove current permission, or replace auth, binding/CAS and help/exposure checks.
 * Never pass raw author props, rows, keys, source text or getClientInit here.
 */
export type MaterialFirstAnswerInput = z.infer<typeof inputSchema>;
export type MaterialFirstAnswerPresentation = {
  attemptId: string;
  itemVersionId: string;
  problemId: string;
  activityId: string;
  courseId: string;
  blockId: string;
  contentVersion: number;
  prompt: z.infer<typeof presentationSchema>;
};
export type MaterialFirstAnswerResult =
  | { ok: true; presentation: MaterialFirstAnswerPresentation }
  | { ok: false; code: "INVALID_FIRST_ANSWER" };

// Snapshot bounded own data before Zod: ordinary parsing may invoke accessors.
// Limits include rejected fields; no caller values/keys/errors leave this boundary.
function snapshotOwnData(input: unknown): unknown {
  let nodes = 0;
  let characters = 0;
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 200 || depth > 6) throw new Error();
    if (typeof value === "string") {
      characters += value.length;
      if (value.length > 8000 || characters > 16000 || value.normalize("NFC") !== value
        || /\p{Cf}/u.test(value)) throw new Error();
      for (const character of value) {
        const point = character.codePointAt(0)!;
        if (point >= 0xd800 && point <= 0xdfff || point < 32 && ![9, 10, 13].includes(point)
          || point >= 127 && point <= 159) throw new Error();
      }
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) throw new Error();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string") || keys.length > (array ? 9 : 16)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isInteger(length.value)
        || length.value < 0 || length.value > 8 || keys.length !== length.value + 1) throw new Error();
      const result: unknown[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  return copy(input, 0);
}

/**
 * Pure first-answer transport projection only; success is never an authorization
 * receipt or runtime readiness claim. Plain text may still contain a semantic
 * answer: the server must review the stem/options and authorize each opaque
 * locator without revealing mixed/answer chunks. No source content is accepted.
 * This is deliberately separate from getClientInit and has no public barrel export.
 */
export function projectMaterialFirstAnswer(input: unknown): MaterialFirstAnswerResult {
  const invalid = { ok: false, code: "INVALID_FIRST_ANSWER" } as const;
  try {
    const parsed = inputSchema.safeParse(snapshotOwnData(input));
    if (!parsed.success) return invalid;
    const { binding, publication, issuance, presentation } = parsed.data;
    if (publication.mappingId !== binding.mappingId || publication.bindingRevision !== binding.revision
      || Object.keys(publication).some(key => publication[key as keyof typeof publication]
        !== issuance.publication[key as keyof typeof publication])) return invalid;
    const authorized = new Map(binding.sourceLocators.map(ref => [ref.locatorId, ref]));
    if (presentation.sourceLocators.some(ref => {
      const expected = authorized.get(ref.locatorId);
      return !expected || expected.sourceId !== ref.sourceId || expected.sourceVersion !== ref.sourceVersion;
    })) return invalid;
    // Construct only named public fields. Private binding/publication facts stay local.
    return { ok: true, presentation: {
      attemptId: issuance.attemptId,
      itemVersionId: issuance.itemVersionId,
      problemId: issuance.problemId,
      activityId: publication.activityId,
      courseId: publication.courseId,
      blockId: publication.blockId,
      contentVersion: publication.contentVersion,
      prompt: presentation,
    } };
  } catch {
    // Boundary conversion only: never echo private payloads, paths or parser issues.
    return invalid;
  }
}
