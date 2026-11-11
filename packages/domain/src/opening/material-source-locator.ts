import { z } from "zod";
import { materialCourseFullPackageSchema } from "./material-course-package-adapter";

const identity = z.string().min(1).max(200);
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase());
const hasControlCharacters = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const fileName = identity.refine(value => /\.pdf$/i.test(value)
  && !/[\\/:%?#]/.test(value) && !hasControlCharacters(value) && value === value.trim(), "Expected a PDF manifest basename");
// Override only basename fields at the raw boundary: the adapter's key schema trims strings.
const locatorPackageSchema = materialCourseFullPackageSchema.extend({
  sources: z.array(materialCourseFullPackageSchema.shape.sources.element.extend({ file: fileName, sha256 })).min(1),
  questions: z.array(materialCourseFullPackageSchema.shape.questions.element.extend({ sourceFile: fileName })),
  skills: z.array(materialCourseFullPackageSchema.shape.skills.element.extend({
    sourceRefs: z.array(materialCourseFullPackageSchema.shape.skills.element.shape.sourceRefs.element.extend({ file: fileName })).min(1),
  })).min(1),
});
const pdfUrl = z.string().refine(value => {
  // Validate raw input before parsing: neither Zod trimming nor URL authority repair is allowed.
  if (/[\\\s]/.test(value) || hasControlCharacters(value) || value.includes("#")
    || !/^https:\/\/[^/?#]+(?:[/?]|$)/.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password
    && !/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value.split("?")[0]!)
    && !/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname);
}, "Expected an explicit host-provided HTTPS PDF URL");

/** Host attests the authorized PDF bytes/identity; this module cannot verify bytes or ownership. */
export const materialProvidedSourceSchema = z.object({
  file: fileName, pdfSha256: sha256, sourceId: z.string().uuid().transform(value => value.toLowerCase()),
  sourceVersion: z.number().int().nonnegative(), pdfUrl,
}).strict();
export type MaterialProvidedSource = z.infer<typeof materialProvidedSourceSchema>;

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), questionId: identity }).strict(),
  z.object({ kind: z.literal("skill"), skillId: identity }).strict(),
]);
export type MaterialSourceLocatorRequest = z.infer<typeof requestSchema>;
export type MaterialPdfLocation = Readonly<{
  file: string; pdfSha256: string; physicalPage: number; pageCount: number;
  mappingStatus: "text-reviewed" | "needs-visual-check";
} & ({
  status: "located"; sourceId: string; sourceVersion: number;
  /** Host opens this exact URL with this fragment; not a fetch/import endpoint. */
  target: Readonly<{ pdfUrl: string; fragment: `#page=${number}` }>;
} | { status: "unbound"; sourceId: null; sourceVersion: null; target: null })>;
export type MaterialSourceLocatorResult = Readonly<{
  request: MaterialSourceLocatorRequest; locations: readonly MaterialPdfLocation[];
  bodyStatus: "metadata_only"; prompt: null; answer: null; canonicalFamilyId: null;
  visualReview: "pending"; mathematicalVerification: "unverified";
  diagnosticEligible: false; scoringEligible: false; bktEligible: false;
}>;

/**
 * Pure, read-only preview locator for the current full mapping package (not body text).
 * Uses the adapter R3 strict schema; superseded notes/diagnosticEligible inputs are not accepted.
 * Readiness, post-attempt notes, objectives and common errors never become prompt/answer content.
 * Only exact manifest keys + SHA bindings supplied by the host can produce an open target.
 * A manifest-only or unbound PDF remains metadata; no filename-to-URL/DB-ID inference.
 * URL syntax checks are not host authorization or PDF-byte verification. No I/O occurs here.
 */
export function createMaterialSourceLocator(input: unknown, providedSources: unknown = []) {
  const pack = locatorPackageSchema.parse(input);
  const bindings = z.array(materialProvidedSourceSchema).parse(providedSources);
  const fail = (): never => { throw new Error("Invalid material source identity, hash or page reference"); };
  const unique = (values: string[]) => { if (new Set(values).size !== values.length) fail(); };
  unique(pack.sources.map(source => source.file));
  unique(pack.questions.map(question => question.id));
  unique(pack.skills.map(skill => skill.id));
  unique(bindings.map(source => source.file));
  unique(bindings.map(source => source.sourceId));
  // A URL may not claim two different PDF identities, even if their page counts happen to match.
  unique(bindings.map(source => new URL(source.pdfUrl).href));
  const sources = new Map(pack.sources.map(source => [source.file, source]));
  const bound = new Map(bindings.map(source => [source.file, source]));
  for (const binding of bindings) {
    const source = sources.get(binding.file);
    if (!source || source.sha256 !== binding.pdfSha256) fail();
  }
  const questions = new Map(pack.questions.map(question => [question.id, question]));
  const skills = new Map(pack.skills.map(skill => [skill.id, skill]));
  const checkPage = (file: string, page: number) => {
    const source = sources.get(file);
    if (!source || !Number.isSafeInteger(page) || page < 1 || page > source.physicalPages) fail();
  };
  for (const question of pack.questions) {
    checkPage(question.sourceFile, question.physicalPage);
    for (const skillId of [question.primarySkillId, ...question.secondarySkillIds]) if (!skills.has(skillId)) fail();
  }
  for (const skill of pack.skills) for (const ref of skill.sourceRefs) {
    for (const page of ref.physicalPages) checkPage(ref.file, page);
  }
  const location = (file: string, physicalPage: number, mappingStatus: MaterialPdfLocation["mappingStatus"]): MaterialPdfLocation => {
    const source = sources.get(file)!;
    const binding = bound.get(file);
    const metadata = { file, pdfSha256: source.sha256, physicalPage, pageCount: source.physicalPages, mappingStatus };
    return binding ? { ...metadata, status: "located", sourceId: binding.sourceId, sourceVersion: binding.sourceVersion,
      target: { pdfUrl: binding.pdfUrl, fragment: `#page=${physicalPage}` } }
      : { ...metadata, status: "unbound", sourceId: null, sourceVersion: null, target: null };
  };
  return {
    resolve(request: MaterialSourceLocatorRequest): MaterialSourceLocatorResult {
      const query = requestSchema.parse(request);
      let locations: MaterialPdfLocation[];
      if (query.kind === "question") {
        const question = questions.get(query.questionId);
        if (!question) return fail();
        locations = [location(question.sourceFile, question.physicalPage, question.mappingStatus)];
      } else {
        const skill = skills.get(query.skillId);
        if (!skill) return fail();
        locations = skill.sourceRefs.flatMap(ref => ref.physicalPages.map(page => location(ref.file, page, ref.verification)));
      }
      return { request: query, locations, bodyStatus: "metadata_only", prompt: null, answer: null, canonicalFamilyId: null,
        visualReview: "pending", mathematicalVerification: "unverified", diagnosticEligible: false, scoringEligible: false, bktEligible: false };
    },
  };
}
