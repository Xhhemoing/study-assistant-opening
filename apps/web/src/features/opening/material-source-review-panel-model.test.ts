import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptMaterialCourseFullPackage, materialCourseFullPackageSchema } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { readMaterialSourceReview, type MaterialSourceReviewInput } from "./material-source-review-panel-model";

// Current real material stays private. Synthetic host bindings are not runtime identity proof.
function load(): MaterialSourceReviewInput {
  const bytes = readFileSync(process.env.MATERIAL_COURSE_REAL_FULL_INPUT!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return materialCourseFullPackageSchema.parse(JSON.parse(bytes.toString("utf8")));
}
const hostBindings = (pack: MaterialSourceReviewInput) => pack.sources.map((s, i) => ({ file: s.file, pdfSha256: s.sha256,
  sourceId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, sourceVersion: i,
  pdfUrl: `https://synthetic.example/pdf-${i}.pdf?signature=A%2Bb&keep=%2F` }));
it.each([null, undefined, {}, { questions: [] }])("fails closed on malformed input %j", input => expect(readMaterialSourceReview(input)).toBeNull());

describe.skipIf(!process.env.MATERIAL_COURSE_REAL_FULL_INPUT)("current 041fc package typed panel projection", () => {
  it("maps all 150 questions, 77 skills, 15 PDFs and 385 locations with exact explicit synthetic identity or unbound defaults", () => {
    const pack = load(), before = JSON.stringify(pack), bindings = hostBindings(pack);
    const model = readMaterialSourceReview(pack, bindings)!; const unbound = readMaterialSourceReview(pack)!;
    expect(pack.questions).toHaveLength(150); expect(pack.skills).toHaveLength(77); expect(pack.sources).toHaveLength(15);
    expect(model.choices).toHaveLength(227); expect(model.choices.flatMap(c => c.result.locations)).toHaveLength(385);
    for (const c of model.choices) {
      const refs = c.request.kind === "question"
        ? pack.questions.filter(q => q.id === (c.request.kind === "question" ? c.request.questionId : "")).map(q => ({ file: q.sourceFile, page: q.physicalPage, status: q.mappingStatus }))
        : pack.skills.filter(s => s.id === (c.request.kind === "skill" ? c.request.skillId : "")).flatMap(s => s.sourceRefs.flatMap(r => r.physicalPages.map(page => ({ file: r.file, page, status: r.verification }))));
      expect(c.result.locations).toHaveLength(refs.length);
      refs.forEach((r, index) => {
        const source = pack.sources.find(s => s.file === r.file)!, binding = bindings.find(b => b.file === r.file)!;
        expect(c.result.locations[index]).toEqual({ file: r.file, physicalPage: r.page, pageCount: source.physicalPages, pdfSha256: source.sha256, mappingStatus: r.status, status: "located", sourceId: binding.sourceId, sourceVersion: binding.sourceVersion, target: { pdfUrl: binding.pdfUrl, fragment: `#page=${r.page}` } });
        expect(unbound.choices.find(v => v.key === c.key)!.result.locations[index]).toEqual({ file: r.file, physicalPage: r.page, pageCount: source.physicalPages, pdfSha256: source.sha256, mappingStatus: r.status, status: "unbound", sourceId: null, sourceVersion: null, target: null });
      });
      expect(c.result).toMatchObject({ prompt: null, answer: null, bodyStatus: "metadata_only", canonicalFamilyId: null, visualReview: "pending", mathematicalVerification: "unverified", diagnosticEligible: false, scoringEligible: false, bktEligible: false });
    }
    expect(JSON.stringify(pack)).toBe(before);
  });
  it.each([
    " https://synthetic.example/a", "\nhttps://synthetic.example/a", "\thttps://synthetic.example/a", "https://synthetic.example/a\r\n",
    "https:///synthetic.example/a", "https:////synthetic.example/a", "http://synthetic.example/a", "//synthetic.example/a", "/api/a",
    "https://user:secret@synthetic.example/a", "https://synthetic.example/a#page=3", "https://synthetic.example/%2e%2e/a", "https://synthetic.example/%2fa",
    "https://synthetic.example/a\u0000", "https://synthetic.example/a\u007f", "javascript:alert(1)",
  ])("rejects raw unsafe URL rather than trimming, repairing or inferring: %j", pdfUrl => {
    const pack = load(); expect(readMaterialSourceReview(pack, [{ ...hostBindings(pack)[0], pdfUrl }])).toBeNull();
  });
  it("rejects incomplete host bindings; default, empty and partial bindings stay honestly unbound", () => {
    const pack = load(), binding = hostBindings(pack)[0]!;
    for (const field of ["file", "sourceId", "sourceVersion", "pdfSha256", "pdfUrl"]) {
      const bad: Record<string, unknown> = { ...binding }; delete bad[field];
      expect(readMaterialSourceReview(pack, [bad])).toBeNull();
    }
    expect(readMaterialSourceReview(pack, [])).toEqual(readMaterialSourceReview(pack));
    const partial = readMaterialSourceReview(pack, [binding])!;
    for (const c of partial.choices) for (const l of c.result.locations) {
      expect(l.status).toBe(l.file === binding.file ? "located" : "unbound");
      if (l.status === "unbound") expect(l).toMatchObject({ sourceId: null, sourceVersion: null, target: null });
    }
    const model = readMaterialSourceReview(pack, hostBindings(pack))!;
    expect(model.choices.every(c => c.result.canonicalFamilyId === null)).toBe(true);
  });
  it("closes the entire model on identity aliases, duplicate manifest/IDs, bad hashes or polluted tail references", () => {
    const pack = load(), bindings = hostBindings(pack);
    const alias = "ABCDEFAB-1234-4123-8123-123456789ABC";
    for (const provided of [
      [...bindings, bindings[0]],
      bindings.map((b, i) => i < 2 ? { ...b, sourceId: i === 0 ? alias : alias.toLowerCase() } : b),
      bindings.map((b, i) => i === 1 ? { ...b, pdfUrl: bindings[0]!.pdfUrl } : b),
      bindings.map((b, i) => i === 1 ? { ...b, pdfUrl: bindings[0]!.pdfUrl.replace("https://synthetic.example/", "https://SYNTHETIC.example:443/") } : b),
      bindings.map((b, i) => i === bindings.length - 1 ? { ...b, pdfSha256: "0".repeat(64) } : b),
      bindings.map((b, i) => i === 0 ? { ...b, sourceVersion: -1 } : b),
    ]) expect(readMaterialSourceReview(pack, provided)).toBeNull();
    for (const mutate of [
      (p: MaterialSourceReviewInput) => { p.sources.push({ ...p.sources[0]! }); },
      (p: MaterialSourceReviewInput) => { p.questions.at(-1)!.id = p.questions[0]!.id; },
      (p: MaterialSourceReviewInput) => { p.skills.at(-1)!.id = p.skills[0]!.id; },
      (p: MaterialSourceReviewInput) => { p.questions.at(-1)!.physicalPage = Number.MAX_SAFE_INTEGER + 1; },
      (p: MaterialSourceReviewInput) => { p.skills.at(-1)!.sourceRefs.push({ file: "unknown-tail.pdf", physicalPages: [1], verification: "text-reviewed" }); },
    ]) { const input = structuredClone(pack); mutate(input); expect(readMaterialSourceReview(input, bindings)).toBeNull(); }
  });
  it("checks every real PDF's first/last/under/over pages for both question and skill refs and never promotes visual state", () => {
    const pack = load();
    for (const source of pack.sources) for (const kind of ["question", "skill"] as const) {
      for (const page of [1, source.physicalPages, 0, source.physicalPages + 1]) {
        const input = structuredClone(pack), q = input.questions.at(-1)!, s = input.skills.at(-1)!;
        if (kind === "question") { q.sourceFile = source.file; q.physicalPage = page; q.mappingStatus = "needs-visual-check"; }
        else s.sourceRefs.push({ file: source.file, physicalPages: [page], verification: "needs-visual-check" });
        const model = readMaterialSourceReview(input);
        if (page < 1 || page > source.physicalPages) expect(model).toBeNull();
        else {
          const key = kind === "question" ? `question:${q.id}` : `skill:${s.id}`;
          const c = model!.choices.find(c => c.key === key)!;
          expect(c.result.locations).toContainEqual(expect.objectContaining({ file: source.file, physicalPage: page, mappingStatus: "needs-visual-check", status: "unbound" }));
          expect(c.result).toMatchObject({ visualReview: "pending", diagnosticEligible: false, scoringEligible: false, bktEligible: false });
        }
      }
    }
  });
  it("accepts the current readiness contract, not legacy notes/flags, and keeps private adapter postAttemptMetadata out", () => {
    const pack = load(), candidate = adaptMaterialCourseFullPackage(pack, { deadlineAt: null });
    expect(candidate.postAttemptMetadata).toMatchObject({ role: "feedback_only", independentIfExposedBeforeAnswer: false, scoringEvidence: false });
    expect(candidate.postAttemptMetadata.questions).toHaveLength(150); expect(candidate.postAttemptMetadata.skills).toHaveLength(77);
    expect(readMaterialSourceReview(candidate)).toBeNull(); // output/private feedback is not raw input
    pack.questions[0]!.postAttemptNotes = "PRIVATE_POST_ATTEMPT_SENTINEL";
    pack.skills[0]!.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"]; pack.skills[0]!.commonErrors = ["PRIVATE_ERROR_SENTINEL"];
    const model = readMaterialSourceReview(pack)!; expect(model).not.toBeNull(); expect(JSON.stringify(model)).not.toContain("PRIVATE_");
    expect(JSON.stringify(model)).not.toMatch(/postAttemptNotes|postAttemptMetadata|learningObjectives|commonErrors/);
    expect(readMaterialSourceReview({ ...pack, questions: [{ ...pack.questions[0], notes: "legacy" }] })).toBeNull();
    expect(readMaterialSourceReview({ ...pack, questions: [{ ...pack.questions[0], diagnosticEligible: true }] })).toBeNull();
    expect(readMaterialSourceReview({ ...pack, postAttemptMetadata: candidate.postAttemptMetadata })).toBeNull();
  });
  it("applies the same readiness/no-admission policy to all 20 entry and 5 supplemental candidates", () => {
    const pack = load(); expect(pack.diagnostic.questionIds).toHaveLength(20); expect(pack.diagnostic.constructedResponseCandidates).toHaveLength(5);
    for (const id of [...pack.diagnostic.questionIds, ...pack.diagnostic.constructedResponseCandidates]) {
      const input = structuredClone(pack), q = input.questions.find(q => q.id === id)!;
      for (const readiness of [false, "blocked-author-exclusion", "blocked-visual-check", "requires-answer-key-and-exposure-check"] as const) {
        q.assessmentReadiness = readiness;
        const choice = readMaterialSourceReview(input)!.choices.find(c => c.key === `question:${id}`)!;
        expect(choice.questionStatuses[0]!.assessmentReadiness).toBe(readiness);
        expect(choice.questionStatuses[0]!.declaredDiagnosticRole).toBe(pack.diagnostic.questionIds.includes(id) ? "entry-candidate" : "supplemental-candidate");
        expect(choice.result).toMatchObject({ diagnosticEligible: false, scoringEligible: false, bktEligible: false });
      }
      q.assessmentReadiness = "requires-answer-key-and-exposure-check"; q.bktAdmission = false;
      expect(readMaterialSourceReview(input)!.choices.find(c => c.key === `question:${id}`)!.questionStatuses[0]!.reasons.join()).toContain("bktAdmission=false");
    }
    for (const id of pack.validation.visualCheckRequired) {
      const choice = readMaterialSourceReview(pack)!.choices.find(c => c.key === `question:${id}`)!;
      expect(choice.result.locations[0]!.mappingStatus).toBe("needs-visual-check"); expect(choice.result.visualReview).toBe("pending");
    }
  });
});
