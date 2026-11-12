import { z } from "zod";
import { sha256HexSchema, uuidSchema } from "./foundation";
import { sourceChunkSchema } from "./sources";
import { teachingQuestionInteractionSchema } from "./teaching-activity";
import { teachingBlockRoleSchema } from "./teaching-content";

export const MATERIAL_IMPORT_BINDING_SCHEMA_VERSION = 1 as const;
const versionSchema = sourceChunkSchema.shape.sourceVersion;
const digestSchema = sha256HexSchema.transform(value => value.toLowerCase());

/** JSON-shaped data only; inspect descriptors BEFORE Zod can evaluate a getter.
 * Bounds also cap work on non-HTTP callers. Proxies are not a supported input boundary.
 */
function isBoundedData(value: unknown, depth = 0, budget = { nodes: 256 }): boolean {
  if (--budget.nodes < 0 || depth > 10) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 20_000;
  if (typeof value !== "object") return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  if (array && Object.getOwnPropertyDescriptor(value, "length")!.value > 32) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) return false;
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) return false;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    if (!isBoundedData(descriptor.value, depth + 1, budget)) return false;
  }
  return true;
}
const dataBoundarySchema = z.unknown().superRefine((value, ctx) => {
  if (!isBoundedData(value)) ctx.addIssue({ code: "custom", message: "Expected bounded plain data without accessors" });
});

// Preserve spaces, Unicode and terminal LF. Only CRLF and lone CR become LF.
// Reject unpaired surrogates: UTF-8 replacement would otherwise conflate distinct inputs.
const textSchema = z.string().min(1).max(8_000).refine(value => value.trim().length > 0, "Text must not be blank")
  .refine(value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "Text must be valid Unicode");
const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");
const canonicalTextSchema = textSchema.transform(normalizeNewlines);

const questionContentShape = z.object({
  schemaVersion: z.literal(MATERIAL_IMPORT_BINDING_SCHEMA_VERSION),
  contentVersion: versionSchema,
  stem: canonicalTextSchema,
  // Existing bounded numeric/unit or choice/options controls, not grading criteria.
  interaction: teachingQuestionInteractionSchema.transform(interaction => interaction.kind === "numeric"
    ? { ...interaction, ...(interaction.unit === undefined ? {} : { unit: normalizeNewlines(interaction.unit) }) }
    : { ...interaction, options: interaction.options.map(option => ({ id: normalizeNewlines(option.id), label: normalizeNewlines(option.label) })) }),
}).strict();
const answerContentShape = z.object({
  schemaVersion: z.literal(MATERIAL_IMPORT_BINDING_SCHEMA_VERSION),
  contentVersion: versionSchema,
  role: teachingBlockRoleSchema.extract(["answer_key"]),
  text: canonicalTextSchema,
}).strict();

// Canonical interaction strings need the same Unicode rules, including optional empty unit.
function validateInteraction(content: z.infer<typeof questionContentShape>, ctx: z.RefinementCtx) {
  const interaction = content.interaction;
  const strings = interaction.kind === "numeric" ? [interaction.unit ?? ""]
    : interaction.options.flatMap(option => [option.id, option.label]);
  if (strings.some(value => value !== "" && !textSchema.safeParse(value).success)) {
    ctx.addIssue({ code: "custom", path: ["interaction"], message: "Interaction strings must be nonblank valid Unicode" });
  }
  if (interaction.kind === "choice" && new Set(interaction.options.map(option => option.id)).size !== interaction.options.length) {
    ctx.addIssue({ code: "custom", path: ["interaction", "options"], message: "Canonical option IDs must be unique" });
  }
}
export const materialImportQuestionContentSchema = dataBoundarySchema.pipe(questionContentShape.superRefine(validateInteraction));
export const materialImportAnswerContentSchema = dataBoundarySchema.pipe(answerContentShape);

/** Offsets are [start,end) UTF-16 indices into the ACTUAL retained chunk.text,
 * before newline normalization. Server must re-resolve chunkId/version/page and bounds.
 * printedLabel is manual display metadata, never a physical page or a chunk key.
 */
const locatorSchema = z.object({
  sourceId: sourceChunkSchema.shape.sourceId,
  sourceVersion: versionSchema,
  sourceSha256: digestSchema,
  chunkId: sourceChunkSchema.shape.id,
  physicalPage: sourceChunkSchema.shape.page,
  printedLabel: z.string().min(1).max(120).nullable(),
  textRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
}).strict().superRefine((locator, ctx) => {
  if (locator.textRange.start >= locator.textRange.end) {
    ctx.addIssue({ code: "custom", path: ["textRange"], message: "Text range must be nonempty and ordered" });
  }
});

/** PRIVATE manual single-question input, NOT a manifest, safe DTO, authenticated
 * fact, trusted key or producer. No owner/reviewer/time/grant/eligibility from clients.
 * The future server must authenticate, resolve current/retained SHA + actual locators,
 * purpose and manifest CAS, and supply reviewer/time itself. A parsed hash proves
 * neither provenance truth nor correctness. Never project this object into first-answer.
 */
export const materialImportBindingInputSchema = dataBoundarySchema.pipe(z.object({
  schemaVersion: z.literal(MATERIAL_IMPORT_BINDING_SCHEMA_VERSION),
  sourceId: sourceChunkSchema.shape.sourceId,
  sourceVersion: versionSchema,
  sourceSha256: digestSchema,
  expectedManifestRevision: versionSchema,
  mappingId: uuidSchema,
  // Stable mapping-local question identity, not an existing problem or trusted identity.
  questionId: uuidSchema,
  question: z.object({
    locator: locatorSchema,
    content: materialImportQuestionContentSchema,
    expectedContentSha256: digestSchema.optional(),
  }).strict(),
  answer: z.object({
    locator: locatorSchema,
    content: materialImportAnswerContentSchema,
    expectedContentSha256: digestSchema.optional(),
  }).strict(),
  manualConfirmation: z.object({ method: z.literal("manual_transcription"), confirmed: z.literal(true) }).strict(),
}).strict().superRefine((input, ctx) => {
  for (const part of ["question", "answer"] as const) {
    const locator = input[part].locator;
    if (locator.sourceId !== input.sourceId || locator.sourceVersion !== input.sourceVersion || locator.sourceSha256 !== input.sourceSha256) {
      ctx.addIssue({ code: "custom", path: [part, "locator"], message: "First slice requires the same source, version and expected source SHA" });
    }
  }
  const q = input.question.locator;
  const a = input.answer.locator;
  if (q.chunkId === a.chunkId) {
    if (q.physicalPage !== a.physicalPage || q.printedLabel !== a.printedLabel) {
      ctx.addIssue({ code: "custom", path: ["answer", "locator"], message: "One chunk cannot have conflicting page metadata" });
    }
    if (q.textRange.start < a.textRange.end && a.textRange.start < q.textRange.end) {
      ctx.addIssue({ code: "custom", path: ["answer", "locator", "textRange"], message: "Question and answer text ranges must not overlap" });
    }
  }
}));

export type MaterialImportBindingInput = z.infer<typeof materialImportBindingInputSchema>;
export type MaterialImportQuestionContent = z.infer<typeof materialImportQuestionContentSchema>;
export type MaterialImportAnswerContent = z.infer<typeof materialImportAnswerContentSchema>;

/** Canonical v1 is UTF-8 netstrings, NOT JSON. Each field is decimal UTF-8 byte
 * length + ':' + value + ','; no BOM/separators/final newline beyond field bytes.
 * Order: domain, schemaVersion, contentVersion, then question stem, interaction kind,
 * numeric unit presence (0/1) + optional unit OR option count + each id,label IN ORDER;
 * answer uses role,text instead. Integers use base-10. All text CRLF/CR -> LF, with no
 * trimming or Unicode normalization. Missing numeric unit differs from empty unit.
 * Source/locator/mapping/expected hashes are deliberately NOT content fields: the
 * server must persist them together separately; a content digest cannot authorize them.
 */
function encodeFields(fields: string[]): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(fields.map(field => {
    const normalized = normalizeNewlines(field);
    return `${encoder.encode(normalized).byteLength}:${normalized},`;
  }).join(""));
}
export function canonicalMaterialImportQuestionContent(input: unknown): Uint8Array {
  const content = materialImportQuestionContentSchema.parse(input);
  const interaction = content.interaction;
  const fields = ["material-import-question-1", String(content.schemaVersion), String(content.contentVersion), content.stem, interaction.kind];
  if (interaction.kind === "numeric") {
    fields.push(interaction.unit === undefined ? "0" : "1");
    if (interaction.unit !== undefined) fields.push(interaction.unit);
  } else {
    fields.push(String(interaction.options.length));
    for (const option of interaction.options) fields.push(option.id, option.label);
  }
  return encodeFields(fields);
}
export function canonicalMaterialImportAnswerContent(input: unknown): Uint8Array {
  const content = materialImportAnswerContentSchema.parse(input);
  return encodeFields(["material-import-answer-1", String(content.schemaVersion), String(content.contentVersion), content.role, content.text]);
}

/** Inject a real SERVER SHA-256 implementation; contracts never import node:crypto
 * or choose a browser crypto fallback. This helper validates expected content hashes
 * only, NOT the client source SHA against actual source bytes. Errors propagate.
 */
export type MaterialImportComputeSha256 = (canonicalUtf8: Uint8Array) => string | Promise<string>;
export async function computeMaterialImportContentHashes(input: unknown, serverComputeSha256: MaterialImportComputeSha256) {
  const binding = materialImportBindingInputSchema.parse(input);
  const questionContentSha256 = digestSchema.parse(await serverComputeSha256(canonicalMaterialImportQuestionContent(binding.question.content)));
  const answerContentSha256 = digestSchema.parse(await serverComputeSha256(canonicalMaterialImportAnswerContent(binding.answer.content)));
  if (binding.question.expectedContentSha256 !== undefined && binding.question.expectedContentSha256 !== questionContentSha256) {
    throw new Error("Question content SHA-256 mismatch");
  }
  if (binding.answer.expectedContentSha256 !== undefined && binding.answer.expectedContentSha256 !== answerContentSha256) {
    throw new Error("Answer content SHA-256 mismatch");
  }
  return { questionContentSha256, answerContentSha256 };
}
