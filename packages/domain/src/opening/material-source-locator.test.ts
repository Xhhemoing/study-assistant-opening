import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type MaterialCourseFullPackage, materialCourseFullPackageSchema } from "./material-course-package-adapter";
import {
  createMaterialSourceLocator, type MaterialProvidedSource, type MaterialSourceLocatorRequest,
} from "./material-source-locator";

// Synthetic format fixtures only: neither UUIDs nor URLs claim actual runtime PDF bindings.
function fixture(): MaterialCourseFullPackage {
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [
      { file: "fixture.pdf", sha256: "c".repeat(64), physicalPages: 3 },
      { file: "other.pdf", sha256: "d".repeat(64), physicalPages: 2 },
      { file: "manifest-only.pdf", sha256: "e".repeat(64), physicalPages: 1 },
    ],
    skills: [{ id: "skill", title: "Synthetic skill", topic: 1, prerequisiteIds: [], learningObjectives: [], commonErrors: [],
      sourceRefs: [{ file: "fixture.pdf", physicalPages: [1, 3], verification: "text-reviewed" },
        { file: "other.pdf", physicalPages: [2], verification: "needs-visual-check" }] }],
    prerequisiteOrder: ["skill"],
    questions: [{ id: "q", topic: 1, kind: "Test", number: 1, sourceFile: "fixture.pdf", physicalPage: 3,
      primarySkillId: "skill", secondarySkillIds: [], evidenceType: "objective-choice", mappingStatus: "text-reviewed",
      postAttemptNotes: "Synthetic post-attempt note, NOT a question body", assessmentReadiness: "requires-answer-key-and-exposure-check",
      bktAdmission: "requires-runtime-evidence-qualification" }],
    diagnostic: { status: "candidate-not-administered", source: "Synthetic metadata", questionIds: ["q"], constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No admission", requiredRuntimeChecks: [],
      constructedResponsePolicy: "Unverified", familyPolicy: "Page position is not a family", feedbackPolicy: "Post-attempt notes only" },
    schedule: { productTarget: "Synthetic", latestProductUseDate: "Unknown", actualExamDate: null, dailyStudyMinutes: null, policy: "No inference",
      unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 3, questionCount: 1, skillCount: 1, textMappedCount: 1, visualCheckRequired: [], disputedDiagnosticExclusions: [],
      semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}
function hostFixture(pack = fixture()): MaterialProvidedSource[] {
  return pack.sources.map((source, index) => ({ file: source.file, pdfSha256: source.sha256,
    sourceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, sourceVersion: index,
    // Deliberately unrelated to filenames: never construct URLs from author input.
    pdfUrl: `https://pdf-host.invalid/authorized/opaque-${index}?signature=fixture%2Btoken` }));
}
const noAdmission = {
  bodyStatus: "metadata_only", prompt: null, answer: null, canonicalFamilyId: null, visualReview: "pending",
  mathematicalVerification: "unverified", diagnosticEligible: false, scoringEligible: false, bktEligible: false,
} as const;

describe("material source locator", () => {
  it("locates question and multi-PDF skill pages through explicit host identities and URL fragments only", () => {
    const pack = fixture(), bindings = hostFixture(pack);
    const before = structuredClone({ pack, bindings });
    const resolver = createMaterialSourceLocator(pack, bindings);
    const question = resolver.resolve({ kind: "question", questionId: "q" });
    expect(question).toMatchObject(noAdmission);
    expect(question.locations).toEqual([{
      status: "located", file: "fixture.pdf", physicalPage: 3, pageCount: 3, pdfSha256: "c".repeat(64), mappingStatus: "text-reviewed",
      sourceId: bindings[0]!.sourceId, sourceVersion: 0, target: { pdfUrl: bindings[0]!.pdfUrl, fragment: "#page=3" },
    }]);
    const skill = resolver.resolve({ kind: "skill", skillId: "skill" });
    expect(skill).toMatchObject(noAdmission);
    expect(skill.locations.map(ref => [ref.file, ref.physicalPage, ref.mappingStatus])).toEqual([
      ["fixture.pdf", 1, "text-reviewed"], ["fixture.pdf", 3, "text-reviewed"], ["other.pdf", 2, "needs-visual-check"],
    ]);
    expect({ pack, bindings }).toEqual(before);
    expect(JSON.stringify(question)).not.toContain(pack.questions[0]!.postAttemptNotes);
  });

  it("returns honest unbound metadata, including mixed bindings; manifest-only PDFs need no runtime reference", () => {
    const pack = fixture();
    const unbound = createMaterialSourceLocator(pack).resolve({ kind: "question", questionId: "q" });
    expect(unbound).toMatchObject(noAdmission);
    expect(unbound.locations).toEqual([{
      status: "unbound", file: "fixture.pdf", physicalPage: 3, pageCount: 3, pdfSha256: "c".repeat(64), mappingStatus: "text-reviewed",
      sourceId: null, sourceVersion: null, target: null,
    }]);
    const partial = createMaterialSourceLocator(pack, hostFixture(pack).slice(0, 1));
    expect(partial.resolve({ kind: "skill", skillId: "skill" }).locations.map(ref => ref.status)).toEqual(["located", "located", "unbound"]);
    expect(() => createMaterialSourceLocator(pack, hostFixture(pack))).not.toThrow();
  });

  it("snapshots input/bindings without retaining mutable caller or result objects", () => {
    const pack = fixture(), bindings = hostFixture(pack);
    const resolver = createMaterialSourceLocator(pack, bindings);
    pack.questions[0]!.physicalPage = 999;
    bindings[0]!.pdfUrl = "https://changed.invalid/";
    const first = resolver.resolve({ kind: "question", questionId: "q" });
    Reflect.set(first.locations[0]!, "physicalPage", 999);
    const location = first.locations[0]!;
    if (location.status === "located") Reflect.set(location.target, "pdfUrl", "https://changed.invalid/");
    expect(resolver.resolve({ kind: "question", questionId: "q" }).locations[0]).toMatchObject({
      physicalPage: 3, target: { pdfUrl: hostFixture()[0]!.pdfUrl },
    });
  });

  it.each(["question", "skill"] as const)("rejects unknown %s identity, without fallback by page or filename", kind => {
    const resolver = createMaterialSourceLocator(fixture(), hostFixture());
    const request: MaterialSourceLocatorRequest = kind === "question" ? { kind, questionId: "unknown" } : { kind, skillId: "unknown" };
    expect(() => resolver.resolve(request)).toThrow();
    expect(() => resolver.resolve({ ...request, pdfUrl: "https://injected.invalid" } as unknown as MaterialSourceLocatorRequest)).toThrow();
  });

  it.each([
    ["duplicate question", (p: MaterialCourseFullPackage) => { p.questions.push(structuredClone(p.questions[0]!)); }],
    ["duplicate skill", (p: MaterialCourseFullPackage) => { p.skills.push(structuredClone(p.skills[0]!)); }],
    ["duplicate manifest", (p: MaterialCourseFullPackage) => { p.sources.push(structuredClone(p.sources[0]!)); }],
    ["conflicting manifest hash", (p: MaterialCourseFullPackage) => { p.sources.push({ ...p.sources[0]!, sha256: "f".repeat(64) }); }],
    ["unknown question PDF", (p: MaterialCourseFullPackage) => { p.questions[0]!.sourceFile = "unknown.pdf"; }],
    ["unknown skill PDF", (p: MaterialCourseFullPackage) => { p.skills[0]!.sourceRefs[0]!.file = "unknown.pdf"; }],
    ["unknown question skill", (p: MaterialCourseFullPackage) => { p.questions[0]!.primarySkillId = "unknown"; }],
    ["unknown secondary skill", (p: MaterialCourseFullPackage) => { p.questions[0]!.secondarySkillIds = ["unknown"]; }],
    ["invalid hash", (p: MaterialCourseFullPackage) => { p.sources[0]!.sha256 = "not-a-sha"; }],
  ] as const)("rejects %s globally, even when requesting another location", (_name, change) => {
    const pack = fixture(); change(pack);
    expect(() => createMaterialSourceLocator(pack)).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 4])("rejects invalid question and skill page %s", page => {
    const question = fixture(); question.questions[0]!.physicalPage = page;
    expect(() => createMaterialSourceLocator(question)).toThrow();
    const skill = fixture(); skill.skills[0]!.sourceRefs[0]!.physicalPages = [page];
    expect(() => createMaterialSourceLocator(skill)).toThrow();
  });

  it.each(["../secret.pdf", "/private/secret.pdf", "C:\\secret.pdf", "nested/secret.pdf", "..%2fsecret.pdf",
    "https://evil.invalid/a.pdf", "a.pdf#page=9", "a.pdf?path=x", "a\n.pdf", " a.pdf", "a.pdf\u0000"])("rejects path-injected manifest key %j", file => {
    const pack = fixture(); pack.sources[0]!.file = file; pack.questions[0]!.sourceFile = file; pack.skills[0]!.sourceRefs[0]!.file = file;
    expect(() => createMaterialSourceLocator(pack)).toThrow();
    expect(() => createMaterialSourceLocator(fixture(), [{ ...hostFixture()[0]!, file }])).toThrow();
  });

  it.each([
    "javascript:alert(1)", "data:application/pdf;base64,AA", "file:///private/a.pdf", "blob:https://host.invalid/id", "http://host.invalid/a.pdf",
    "//host.invalid/a.pdf", "/a.pdf", "a.pdf", "https://", "https://host.invalid/a.pdf#page=99", "https://host.invalid/a.pdf#",
    "https://user:password@host.invalid/a.pdf", "https://host.invalid/a\n.pdf", "https://host.invalid/../a.pdf", "https://host.invalid/%2e%2e/a.pdf",
    "https://host.invalid/..%2fa.pdf", "https://host.invalid/a%5csecret.pdf", "https://host.invalid/a%00.pdf", "https://host.invalid\\evil/a.pdf",
  ])("rejects unsafe host URL %j", pdfUrl => {
    expect(() => createMaterialSourceLocator(fixture(), [{ ...hostFixture()[0]!, pdfUrl }])).toThrow();
  });

  it.each([
    " https://host.invalid/a.pdf", "\nhttps://host.invalid/a.pdf", "\thttps://host.invalid/a.pdf",
    "https://host.invalid/a.pdf ", "https://host.invalid/a.pdf\r\n", "https://host.invalid/a.pdf\t",
    "\thttps://host.invalid/a.pdf\t", "https:///host.invalid/a.pdf", "https:////host.invalid/a.pdf",
  ])("rejects raw host URL repair %j", pdfUrl => {
    expect(() => createMaterialSourceLocator(fixture(), [{ ...hostFixture()[0]!, pdfUrl }])).toThrow();
  });

  it.each([
    "https://PDF-HOST.invalid:443/authorized/%41.pdf?signature=a%2Bb%2Fz&case=%aF",
    "https://pdf-host.invalid/authorized/a.pdf?signature=fixture%2Btoken",
  ])("preserves valid raw host URL %j and its separate page fragment", pdfUrl => {
    const result = createMaterialSourceLocator(fixture(), [{ ...hostFixture()[0]!, pdfUrl }]).resolve({ kind: "question", questionId: "q" });
    expect(result.locations[0]).toMatchObject({ status: "located", target: { pdfUrl, fragment: "#page=3" } });
  });

  it("preserves a host URL/query exactly and compares hashes case-insensitively", () => {
    const bindings = hostFixture(); bindings[0]!.pdfSha256 = bindings[0]!.pdfSha256.toUpperCase();
    const result = createMaterialSourceLocator(fixture(), bindings).resolve({ kind: "question", questionId: "q" });
    expect(result.locations[0]).toMatchObject({ pdfSha256: "c".repeat(64), target: { pdfUrl: bindings[0]!.pdfUrl } });
  });

  it.each(["unknown file", "hash mismatch", "invalid source id", "invalid version", "duplicate file", "duplicate source id", "case-aliased source id", "duplicate URL", "extra URL field"])("rejects host binding %s", mode => {
    const bindings = hostFixture();
    if (mode === "unknown file") bindings[0]!.file = "unknown.pdf";
    if (mode === "hash mismatch") bindings[0]!.pdfSha256 = "f".repeat(64);
    if (mode === "invalid source id") bindings[0]!.sourceId = "inferred-from-filename";
    if (mode === "invalid version") bindings[0]!.sourceVersion = -1;
    if (mode === "duplicate file") bindings.push({ ...bindings[0]!, pdfSha256: "f".repeat(64) });
    if (mode === "duplicate source id") bindings[1]!.sourceId = bindings[0]!.sourceId;
    if (mode === "case-aliased source id") {
      bindings[0]!.sourceId = "abcdefab-0000-4000-8000-000000000001";
      bindings[1]!.sourceId = bindings[0]!.sourceId.toUpperCase();
    }
    if (mode === "duplicate URL") bindings[1]!.pdfUrl = bindings[0]!.pdfUrl;
    if (mode === "extra URL field") Reflect.set(bindings[0]!, "publicUrl", "https://injected.invalid/a.pdf");
    expect(() => createMaterialSourceLocator(fixture(), bindings)).toThrow();
  });

  it.each([
    "requires-answer-key-and-exposure-check", "blocked-visual-check", "blocked-author-exclusion", false,
  ] as const)("keeps unified readiness %s and post-attempt/course guidance out of first-answer content", assessmentReadiness => {
    const pack = fixture();
    pack.questions[0]!.assessmentReadiness = assessmentReadiness;
    pack.questions[0]!.bktAdmission = assessmentReadiness === false ? false : "requires-runtime-evidence-qualification";
    pack.questions[0]!.postAttemptNotes = "PRIVATE_POST_ATTEMPT_HINT_SENTINEL";
    pack.skills[0]!.learningObjectives = ["COURSE_OBJECTIVE_SENTINEL"];
    pack.skills[0]!.commonErrors = ["COURSE_ERROR_SENTINEL"];
    const resolver = createMaterialSourceLocator(pack, hostFixture(pack));
    const results = [resolver.resolve({ kind: "question", questionId: "q" }), resolver.resolve({ kind: "skill", skillId: "skill" })];
    for (const result of results) {
      expect(result).toMatchObject(noAdmission);
      expect(result).not.toHaveProperty("firstAnswer");
      expect(result).not.toHaveProperty("postAttemptNotes");
      expect(result).not.toHaveProperty("assessmentReadiness");
      const serialized = JSON.stringify(result);
      for (const text of [pack.questions[0]!.postAttemptNotes, ...pack.skills[0]!.learningObjectives, ...pack.skills[0]!.commonErrors]) {
        expect(serialized).not.toContain(text);
      }
    }
    expect(results[0]!.locations[0]).toMatchObject({ status: "located", sourceId: hostFixture()[0]!.sourceId });
    expect(results[0]!.canonicalFamilyId).toBeNull();
  });

  it.each(["notes", "diagnosticEligible", "blocked-material-dispute", "missing-post-attempt-notes"])("rejects superseded full-package interface %s", field => {
    const pack = fixture();
    if (field === "notes") Reflect.set(pack.questions[0]!, "notes", "Legacy note");
    if (field === "diagnosticEligible") Reflect.set(pack.questions[0]!, "diagnosticEligible", true);
    if (field === "blocked-material-dispute") Reflect.set(pack.questions[0]!, "assessmentReadiness", field);
    if (field === "missing-post-attempt-notes") Reflect.deleteProperty(pack.questions[0]!, "postAttemptNotes");
    expect(() => createMaterialSourceLocator(pack)).toThrow();
  });

  it.each(["text-reviewed", "needs-visual-check"] as const)("never promotes %s metadata, readiness or page collisions to evidence", mappingStatus => {
    const pack = fixture(); pack.questions[0]!.mappingStatus = mappingStatus;
    pack.questions.push({ ...pack.questions[0]!, id: "same-page-not-same-family", assessmentReadiness: "blocked-author-exclusion" });
    const resolver = createMaterialSourceLocator(pack, hostFixture(pack));
    for (const question of pack.questions) expect(resolver.resolve({ kind: "question", questionId: question.id })).toMatchObject(noAdmission);
  });
});

// Real private package replay is explicit/opt-in: never silently replace missing actual input with a fixture.
const actualPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
describe.skipIf(!actualPath)("actual full package PDF locator replay", () => {
  function actual(): MaterialCourseFullPackage {
    const bytes = readFileSync(actualPath!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    return materialCourseFullPackageSchema.parse(JSON.parse(bytes.toString("utf8")));
  }
  it("replays every actual question/skill reference, source hash and physical page without hardcoded mappings", () => {
    const pack = actual(), bindings = hostFixture(pack);
    expect(pack.questions).toHaveLength(150); expect(pack.skills).toHaveLength(77); expect(pack.sources).toHaveLength(15);
    const sources = new Map(pack.sources.map(source => [source.file, source]));
    const provided = new Map(bindings.map(binding => [binding.file, binding]));
    const resolver = createMaterialSourceLocator(pack, bindings);
    const unbound = createMaterialSourceLocator(pack);
    for (const q of pack.questions) {
      const result = resolver.resolve({ kind: "question", questionId: q.id });
      expect(result).toMatchObject(noAdmission);
      expect(result.locations).toHaveLength(1);
      expect(result.locations[0]).toEqual({ status: "located", file: q.sourceFile, physicalPage: q.physicalPage,
        pageCount: sources.get(q.sourceFile)!.physicalPages, pdfSha256: sources.get(q.sourceFile)!.sha256, mappingStatus: q.mappingStatus,
        sourceId: provided.get(q.sourceFile)!.sourceId, sourceVersion: provided.get(q.sourceFile)!.sourceVersion,
        target: { pdfUrl: provided.get(q.sourceFile)!.pdfUrl, fragment: `#page=${q.physicalPage}` } });
      expect(unbound.resolve({ kind: "question", questionId: q.id }).locations[0]).toMatchObject({ status: "unbound", target: null, sourceId: null });
    }
    for (const skill of pack.skills) {
      const result = resolver.resolve({ kind: "skill", skillId: skill.id });
      expect(result).toMatchObject(noAdmission);
      expect(result.locations).toEqual(skill.sourceRefs.flatMap(ref => ref.physicalPages.map(page => ({
        status: "located", file: ref.file, physicalPage: page, pageCount: sources.get(ref.file)!.physicalPages,
        pdfSha256: sources.get(ref.file)!.sha256, mappingStatus: ref.verification,
        sourceId: provided.get(ref.file)!.sourceId, sourceVersion: provided.get(ref.file)!.sourceVersion,
        target: { pdfUrl: provided.get(ref.file)!.pdfUrl, fragment: `#page=${page}` },
      }))));
    }
    // No demand for reverse runtime references from manifest-only PDFs.
    const referenced = new Set([...pack.questions.map(q => q.sourceFile), ...pack.skills.flatMap(s => s.sourceRefs.map(ref => ref.file))]);
    expect(() => createMaterialSourceLocator(pack, bindings.filter(binding => referenced.has(binding.file)))).not.toThrow();
  });

  it.each([
    { id: "T3-Q17", primary: "t3-taylor", secondary: [] },
    { id: "T5-P10", primary: "t5-power-expansions", secondary: ["t1-algebra-functions"] },
  ])("uses current corrected skill/source mapping for $id without inventing a family", ({ id, primary, secondary }) => {
    const pack = actual();
    const question = pack.questions.find(q => q.id === id)!;
    expect(question).toMatchObject({ primarySkillId: primary, secondarySkillIds: secondary });
    if (id === "T3-Q17") expect([question.primarySkillId, ...question.secondarySkillIds]).not.toContain("t3-taylor-error");
    const bindings = hostFixture(pack), resolver = createMaterialSourceLocator(pack, bindings);
    const source = pack.sources.find(source => source.file === question.sourceFile)!;
    const binding = bindings.find(binding => binding.file === source.file)!;
    const result = resolver.resolve({ kind: "question", questionId: id });
    expect(result).toMatchObject(noAdmission);
    expect(result.locations).toEqual([{
      status: "located", file: source.file, physicalPage: question.physicalPage, pageCount: source.physicalPages,
      pdfSha256: source.sha256, mappingStatus: question.mappingStatus, sourceId: binding.sourceId, sourceVersion: binding.sourceVersion,
      target: { pdfUrl: binding.pdfUrl, fragment: `#page=${question.physicalPage}` },
    }]);
    for (const skillId of [primary, ...secondary]) {
      const skill = pack.skills.find(skill => skill.id === skillId)!;
      const located = resolver.resolve({ kind: "skill", skillId });
      expect(located).toMatchObject(noAdmission);
      expect(located.locations.map(ref => [ref.file, ref.physicalPage])).toEqual(
        skill.sourceRefs.flatMap(ref => ref.physicalPages.map(page => [ref.file, page])),
      );
    }
    const invalid = structuredClone(pack);
    invalid.questions.find(q => q.id === id)!.physicalPage = source.physicalPages + 1;
    expect(() => createMaterialSourceLocator(invalid, bindings)).toThrow();
  });

  it.each([
    "missing-file", "missing-hash", "missing-source-id", "missing-version", "missing-url", "unknown-file", "wrong-hash",
    "duplicate-source-id", "canonical-url-alias", "raw-leading-space", "raw-trailing-crlf", "empty-authority",
  ])("rejects current-package host binding negative control %s", mode => {
    const pack = actual(), bindings = hostFixture(pack);
    const last = bindings.at(-1)!;
    const missingFields: Record<string, string> = { "missing-file": "file", "missing-hash": "pdfSha256", "missing-source-id": "sourceId", "missing-version": "sourceVersion", "missing-url": "pdfUrl" };
    const field = missingFields[mode];
    if (field) Reflect.deleteProperty(last, field);
    if (mode === "unknown-file") last.file = "not-in-current-manifest.pdf";
    if (mode === "wrong-hash") last.pdfSha256 = "0".repeat(64);
    if (mode === "duplicate-source-id") last.sourceId = bindings[0]!.sourceId;
    if (mode === "canonical-url-alias") last.pdfUrl = bindings[0]!.pdfUrl.replace("pdf-host.invalid", "PDF-HOST.invalid:443");
    if (mode === "raw-leading-space") last.pdfUrl = ` ${last.pdfUrl}`;
    if (mode === "raw-trailing-crlf") last.pdfUrl += "\r\n";
    if (mode === "empty-authority") last.pdfUrl = last.pdfUrl.replace("https://", "https:////");
    expect(() => createMaterialSourceLocator(pack, bindings)).toThrow();
  });

  it("rejects unknown source/skill and duplicate identities at the end of the current actual package", () => {
    for (const mode of ["question-source", "skill-source", "question-skill", "duplicate-question", "duplicate-skill", "duplicate-source"]) {
      const pack = actual();
      if (mode === "question-source") pack.questions.at(-1)!.sourceFile = "unknown.pdf";
      if (mode === "skill-source") pack.skills.at(-1)!.sourceRefs.at(-1)!.file = "unknown.pdf";
      if (mode === "question-skill") pack.questions.at(-1)!.secondarySkillIds.push("unknown-skill");
      if (mode === "duplicate-question") pack.questions.push(structuredClone(pack.questions[0]!));
      if (mode === "duplicate-skill") pack.skills.push(structuredClone(pack.skills[0]!));
      if (mode === "duplicate-source") pack.sources.push(structuredClone(pack.sources[0]!));
      expect(() => createMaterialSourceLocator(pack)).toThrow();
    }
  });

  it("checks first/last and rejects under/over bounds for every actual source, for both question and skill refs", () => {
    const original = actual();
    for (const source of original.sources) {
      for (const page of [1, source.physicalPages, 0, source.physicalPages + 1]) {
        for (const kind of ["question", "skill"] as const) {
          const pack = structuredClone(original);
          if (kind === "question") Object.assign(pack.questions[0]!, { sourceFile: source.file, physicalPage: page });
          else pack.skills[0]!.sourceRefs = [{ file: source.file, physicalPages: [page], verification: "text-reviewed" }];
          const build = () => createMaterialSourceLocator(pack, hostFixture(pack));
          if (page < 1 || page > source.physicalPages) expect(build).toThrow();
          else {
            const request: MaterialSourceLocatorRequest = kind === "question" ? { kind, questionId: pack.questions[0]!.id } : { kind, skillId: pack.skills[0]!.id };
            expect(build().resolve(request).locations[0]).toMatchObject({ file: source.file, physicalPage: page, pageCount: source.physicalPages });
          }
        }
      }
      const bindings = hostFixture(original); bindings.find(binding => binding.file === source.file)!.pdfSha256 = "0".repeat(64);
      expect(() => createMaterialSourceLocator(original, bindings)).toThrow();
    }
  });
});
