import { z } from "zod";
import { sha256HexSchema, uuidSchema } from "./foundation";
import { teachingQuestionInteractionSchema } from "./teaching-activity";

const revision = z.number().int().positive().safe();
const sourcePinSchema = z.object({
  sourceId: uuidSchema,
  sourceVersion: z.number().int().nonnegative().safe(),
  sha256: sha256HexSchema,
}).strict();
const locatorSchema = z.object({
  locatorId: uuidSchema,
  artifactId: uuidSchema,
  artifactRevision: revision,
  sourcePin: sourcePinSchema,
}).strict();
const promptSchema = z.object({
  text: z.string().min(1).max(8000).refine(text => text.trim().length > 0),
  interaction: teachingQuestionInteractionSchema,
  // No graphic dependency can be fulfilled by this text-only first slice.
  requiredVisuals: z.enum(["none", "unsupported"]),
}).strict();

/** Schema for snapshotted data; use the projector for the own-data boundary. */
export const materialPromptArtifactCandidateSchema = z.object({
  artifactId: uuidSchema,
  revision,
  sourcePin: sourcePinSchema,
  locator: locatorSchema,
  prompt: promptSchema,
  semanticReviewCandidate: z.object({
    kind: z.literal("structuralCandidate"),
    artifactId: uuidSchema,
    artifactRevision: revision,
    sourcePin: sourcePinSchema,
    locatorId: uuidSchema,
    prompt: promptSchema,
  }).strict(),
}).strict();
export type MaterialPromptArtifactCandidate = z.infer<typeof materialPromptArtifactCandidateSchema>;
export type MaterialPromptArtifactProjection = {
  artifactId: string;
  revision: number;
  sourcePin: z.infer<typeof sourcePinSchema>;
  locator: z.infer<typeof locatorSchema>;
  prompt: Pick<z.infer<typeof promptSchema>, "text" | "interaction">;
};
export type MaterialPromptArtifactProjectionResult =
  | { ok: true; projectionStructurallyValidatedOnly: true; projection: MaterialPromptArtifactProjection }
  | { ok: false; code: "INVALID_MATERIAL_PROMPT_ARTIFACT" | "MATERIAL_PROMPT_ARTIFACT_UNAVAILABLE" };

function snapshotOwnData(input: unknown): unknown {
  let nodes = 0;
  let characters = 0;
  function text(value: string, limit: number): string {
    characters += value.length;
    if (value.length > limit || characters > 32000 || value.normalize("NFC") !== value
      || /\p{Cf}/u.test(value)) throw new Error();
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if (point >= 0xd800 && point <= 0xdfff || point < 32 && ![9, 10, 13].includes(point)
        || point >= 127 && point <= 159) throw new Error();
    }
    return value;
  }
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 320 || depth > 8) throw new Error();
    if (typeof value === "string") return text(value, 8000);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) throw new Error();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? 9 : 16) || keys.some(key => typeof key !== "string")) throw new Error();
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
      text(key, 64);
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  return copy(input, 0);
}

function sameSource(a: MaterialPromptArtifactCandidate["sourcePin"], b: MaterialPromptArtifactCandidate["sourcePin"]): boolean {
  return a.sourceId === b.sourceId && a.sourceVersion === b.sourceVersion && a.sha256 === b.sha256;
}
function samePrompt(a: MaterialPromptArtifactCandidate["prompt"], b: MaterialPromptArtifactCandidate["prompt"]): boolean {
  if (a.text !== b.text || a.requiredVisuals !== b.requiredVisuals) return false;
  const x = a.interaction;
  const y = b.interaction;
  if (x.kind === "numeric" && y.kind === "numeric") return x.unit === y.unit;
  return x.kind === "choice" && y.kind === "choice" && x.options.length === y.options.length
    && x.options.every((option, index) => option.id === y.options[index]!.id && option.label === y.options[index]!.label);
}

/**
 * Pure prompt-only structural projection, NOT semantic safety or authentication.
 * Server-supplied facts may be forged consistently and pass. Plain text/options/
 * units may contain answers or URLs: schemas cannot detect semantic leaks or
 * missing conditions. Review candidates are not authority. Source SHA is merely
 * a supplied content pin (no computation/provenance). Locator equality grants no
 * resolve right. Auth, exact semantic review, revision/purpose and issuance checks
 * belong at server boundaries. No source reads, storage, resolver or producer here.
 * Input is ordinary serialized data, NOT a sandbox for Proxy reflection traps.
 */
export function projectMaterialPromptArtifact(input: unknown): MaterialPromptArtifactProjectionResult {
  const invalid = { ok: false, code: "INVALID_MATERIAL_PROMPT_ARTIFACT" } as const;
  try {
    const parsed = materialPromptArtifactCandidateSchema.safeParse(snapshotOwnData(input));
    if (!parsed.success) return invalid;
    const { artifactId, revision: artifactRevision, sourcePin, locator, prompt, semanticReviewCandidate: candidate } = parsed.data;
    if (locator.artifactId !== artifactId || locator.artifactRevision !== artifactRevision
      || !sameSource(sourcePin, locator.sourcePin) || candidate.artifactId !== artifactId
      || candidate.artifactRevision !== artifactRevision || !sameSource(sourcePin, candidate.sourcePin)
      || candidate.locatorId !== locator.locatorId || !samePrompt(prompt, candidate.prompt)) return invalid;
    if (prompt.requiredVisuals !== "none") return { ok: false, code: "MATERIAL_PROMPT_ARTIFACT_UNAVAILABLE" };
    return { ok: true, projectionStructurallyValidatedOnly: true, projection: {
      artifactId,
      revision: artifactRevision,
      sourcePin,
      locator,
      prompt: { text: prompt.text, interaction: prompt.interaction },
    } };
  } catch {
    // Boundary error conversion; never return caller values, parser issues or paths.
    return invalid;
  }
}
