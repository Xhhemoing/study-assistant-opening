import { materialImportBindingInputSchema, type MaterialImportBindingInput } from "@aistudy/contracts";
import { z } from "zod";

// Owner-supplied, already authorized metadata. Parsing is NOT authentication.
// No retained chunk text, answer, credentials, URLs or first-answer data accepted.
const integer = z.number().int().nonnegative();
const id = z.uuid();
// Metadata has 11 root fields, one chunks array, and at most 1000 four-field
// chunks: 12 + 5 * 1000 value visits, depth 3, and strings at most 200 UTF-16 units.
// Snapshot own data descriptors before Zod reads values. This is not a sandbox
// for in-process Proxies (reflection itself can run their traps).
function snapshotMetadata(value: unknown, depth = 0, budget = { nodes: 5012 }): unknown {
  if (--budget.nodes < 0 || depth > 3) throw new Error("Invalid metadata data");
  if (value === null || typeof value === "number") return value;
  if (typeof value === "string" && value.length <= 200) return value;
  if (typeof value !== "object") throw new Error("Invalid metadata data");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Invalid metadata data");
  const arrayLength: unknown = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : 0;
  if (typeof arrayLength !== "number" || !Number.isInteger(arrayLength) || (array && (arrayLength < 1 || arrayLength > 1000))) throw new Error("Invalid metadata data");
  const length = arrayLength;
  const keys = Reflect.ownKeys(value);
  if (keys.length > (array ? length + 1 : depth === 0 ? 11 : 4)) throw new Error("Invalid metadata data");
  const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") throw new Error("Invalid metadata data");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid metadata data");
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new Error("Invalid metadata data");
    Object.defineProperty(copy, key, { value: snapshotMetadata(descriptor.value, depth + 1, budget), enumerable: true });
  }
  // Dense own indices only: do not inherit array elements or silently fill holes.
  if (array && keys.length !== length + 1) throw new Error("Invalid metadata data");
  return copy;
}
const metadataDataSchema = z.unknown().transform((value, ctx) => {
  try { return snapshotMetadata(value); }
  catch {
    ctx.addIssue({ code: "custom", message: "Expected bounded plain metadata without accessors" });
    return z.NEVER;
  }
});
export const mappingDraftMetadataSchema = metadataDataSchema.pipe(z.object({
  actorKey: z.string().min(1).max(200),
  inputResetKey: z.string().min(1).max(200),
  sourceId: id,
  sourceVersion: integer,
  sourceSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  expectedManifestRevision: integer,
  mappingId: id,
  questionId: id,
  questionContentVersion: integer,
  answerContentVersion: integer,
  chunks: z.array(z.object({
    chunkId: id,
    physicalPage: z.number().int().positive().nullable(),
    // Required and separate from physical page; null explicitly means unknown.
    printedLabel: z.string().min(1).max(120).nullable(),
    textLength: z.number().int().positive(),
  }).strict()).min(1).max(1000),
}).strict().refine(value => new Set(value.chunks.map(chunk => chunk.chunkId)).size === value.chunks.length));
export type MappingDraftMetadata = z.infer<typeof mappingDraftMetadataSchema>;
export type MappingDraftFields = {
  stem: string; answer: string; kind: "numeric" | "choice"; unit: string;
  options: { id: string; label: string }[];
  questionChunk: string; answerChunk: string;
  questionStart: string; questionEnd: string; answerStart: string; answerEnd: string;
  confirmed: boolean;
};
export function emptyMappingDraftFields(): MappingDraftFields {
  return { stem: "", answer: "", kind: "numeric", unit: "", options: [{ id: "", label: "" }, { id: "", label: "" }],
    questionChunk: "", answerChunk: "", questionStart: "", questionEnd: "", answerStart: "", answerEnd: "", confirmed: false };
}
function offset(value: string): number {
  return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
}
export function buildMappingDraft(metadata: MappingDraftMetadata, fields: MappingDraftFields): MaterialImportBindingInput | null {
  if (!fields.confirmed) return null;
  function locator(part: "question" | "answer") {
    const chunk = metadata.chunks.find(item => item.chunkId === fields[`${part}Chunk`]);
    const start = offset(fields[`${part}Start`]), end = offset(fields[`${part}End`]);
    if (!chunk || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || end > chunk.textLength) return null;
    return { sourceId: metadata.sourceId, sourceVersion: metadata.sourceVersion, sourceSha256: metadata.sourceSha256,
      chunkId: chunk.chunkId, physicalPage: chunk.physicalPage, printedLabel: chunk.printedLabel, textRange: { start, end } };
  }
  const questionLocator = locator("question"), answerLocator = locator("answer");
  if (!questionLocator || !answerLocator) return null;
  const result = materialImportBindingInputSchema.safeParse({
    schemaVersion: 1, sourceId: metadata.sourceId, sourceVersion: metadata.sourceVersion, sourceSha256: metadata.sourceSha256,
    expectedManifestRevision: metadata.expectedManifestRevision, mappingId: metadata.mappingId, questionId: metadata.questionId,
    question: { locator: questionLocator, content: { schemaVersion: 1, contentVersion: metadata.questionContentVersion, stem: fields.stem,
      interaction: fields.kind === "numeric" ? { kind: "numeric", ...(fields.unit ? { unit: fields.unit } : {}) } : { kind: "choice", options: fields.options } } },
    answer: { locator: answerLocator, content: { schemaVersion: 1, contentVersion: metadata.answerContentVersion, role: "answer_key", text: fields.answer } },
    manualConfirmation: { method: "manual_transcription", confirmed: true },
  });
  return result.success ? result.data : null;
}
