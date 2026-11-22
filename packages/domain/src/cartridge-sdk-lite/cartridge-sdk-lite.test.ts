import { describe, expect, it } from "vitest";
import { z } from "zod";
import { examPartResultSchema, examQuestionPartsSchema, gradingEvaluationDatasetSchema, gradingEvaluationRunSchema } from "@aistudy/contracts";
import { learnerPackageSchema } from "@aistudy/contracts/learner-portability";
import * as openingContracts from "../../../contracts/src/opening";
import {
  createLearnerPackage, createPortableReview, executeCartridgeLite, exportAnkiTsv, exportLearnerZip,
  exportMarkdown, exportObsidianNote, importAnkiTsv, importLearnerZip, importMarkdown, importObsidianNote,
  queryCartridgeLiteCapability, schedulePortableReview, validateCartridgeLite,
} from "./index";

function replaceArchiveText(archive: Uint8Array, before: string, after: string): Uint8Array {
  const headers = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const start = 30 + headers.getUint16(26, true) + headers.getUint16(28, true);
  const end = start + headers.getUint32(18, true);
  const payload = archive.subarray(start, end);
  const text = new TextDecoder().decode(payload);
  const offset = text.indexOf(before);
  expect(offset).toBeGreaterThanOrEqual(0);
  const encoder = new TextEncoder();
  const replacement = encoder.encode(after);
  expect(replacement.length).toBe(encoder.encode(before).length);
  payload.set(replacement, encoder.encode(text.slice(0, offset)).length);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  headers.setUint32(14, crc ^ 0xffffffff, true);
  headers.setUint32(end + 16, crc ^ 0xffffffff, true);
  return archive;
}

function expectPrivateFrontmatter(markdown: string, context: string): void {
  const path = "notes/example.md";
  const encoded = JSON.stringify(markdown).slice(1, -1);
  const placeholder = "# " + "x".repeat(new TextEncoder().encode(encoded).length - 2);
  const note = importMarkdown(path, placeholder);
  const bundle = createLearnerPackage({ notes: [note], decks: [], reviews: [] });
  expect(() => importMarkdown(path, markdown), context).toThrow(/YAML frontmatter/u);
  expect(() => importObsidianNote(path, markdown), context).toThrow(/YAML frontmatter/u);
  expect(() => exportLearnerZip({ ...bundle, notes: [{ ...note, markdown }] }), context).toThrow(/YAML frontmatter/u);
  const archive = replaceArchiveText(exportLearnerZip(bundle), placeholder, encoded);
  expect(() => importLearnerZip(archive), context).toThrow(/YAML frontmatter/u);
}

function expectPrivateRecord(record: object, name: string, newline: string): void {
  const root = Object.entries(record).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  expectPrivateFrontmatter(["---", ...root, "---", "# Note"].join(newline), `${name} (root)`);
  expectPrivateFrontmatter(["---", "details:", "  - " + JSON.stringify(record), "---", "# Note"].join(newline), `${name} (nested)`);
}

function expectPortableFrontmatter(markdown: string): void {
  const markdownNote = importMarkdown("plain.md", markdown);
  const obsidianNote = importObsidianNote("obsidian.md", markdown);
  expect(exportMarkdown(markdownNote)).toBe(markdown);
  expect(exportObsidianNote(obsidianNote).markdown).toBe(markdown);
  const archive = exportLearnerZip(createLearnerPackage({ notes: [markdownNote, obsidianNote], decks: [], reviews: [] }));
  expect(importLearnerZip(archive).notes.map(exportMarkdown)).toEqual([markdown, markdown]);
}

describe("learner portability", () => {
  it("preserves raw note text and indexes Obsidian links without changing it", () => {
    const text = "\uFEFF---\r\ntitle: 笔记\r\n---\r\n![[图#步骤|图示]] [[#本页]] `[[code]]` \\[[escaped]]\n```ts\n[[in fence]]\n```\n\n";
    const note = importObsidianNote("课程/例题.md", text);
    expect(note.links).toEqual([
      { target: "图", fragment: "步骤", alias: "图示", embed: true, offset: text.indexOf("![[") },
      { target: "", fragment: "本页", alias: null, embed: false, offset: text.indexOf("[[#") },
    ]);
    expect(exportObsidianNote(note)).toEqual({ path: note.path, markdown: text });
    expect(exportMarkdown(importMarkdown(note.path, text))).toBe(text);
  });

  it.each(["\n", "\r\n", "\r"])("ignores Obsidian links in code fences with %j line endings", newline => {
    const markdown = ["---", "title: 课程", "---", "~~~example", "[[example]]", "~~~", "数学 ![[real]]", ""].join(newline);
    const note = importObsidianNote("notes/algebra.md", markdown);
    expect(note.links).toEqual([{ target: "real", fragment: null, alias: null, embed: true, offset: markdown.indexOf("![[real]]") }]);
    expect(exportObsidianNote(note).markdown).toBe(markdown);
  });

  it("round-trips quoted Anki fields, FSRS snapshots and deterministic in-memory ZIP bytes", () => {
    const deck = { name: "数学::线代", cards: [{ id: "guid-1", front: "\"题目\"\t甲\r\n乙", back: "答案\n", source: "", tags: ["exam", "章节::线代"] }] };
    const tsv = exportAnkiTsv(deck);
    expect(importAnkiTsv(tsv)).toEqual(deck);
    expect(importAnkiTsv(exportAnkiTsv({ name: "Empty deck", cards: [] }))).toEqual({ name: "Empty deck", cards: [] });
    expect(() => importAnkiTsv(tsv + "\tunexpected")).toThrow(/five Anki TSV fields/u);

    const now = new Date("2026-11-21T12:00:00Z");
    const first = createPortableReview(deck.cards[0]!.id, now);
    const reviewed = schedulePortableReview(first, "good", now);
    expect(reviewed).toMatchObject({ cardId: first.cardId, reps: 1, lastReviewAt: now.toISOString() });
    expect(Date.parse(reviewed.dueAt)).toBeGreaterThan(now.valueOf());
    expect(() => schedulePortableReview(reviewed, "again", new Date(now.valueOf() - 1))).toThrow(/review time/u);

    const bundle = createLearnerPackage({ notes: [importMarkdown("x.md", "# $x$\r\n")], decks: [deck], reviews: [reviewed] });
    const archive = exportLearnerZip(bundle);
    expect(archive.slice(0, 4)).toEqual(Uint8Array.of(0x50, 0x4b, 3, 4));
    expect(archive).toEqual(exportLearnerZip(bundle));
    expect(importLearnerZip(archive)).toEqual(bundle);
    const corrupt = archive.slice();
    corrupt[60] = corrupt[60]! ^ 1;
    expect(() => importLearnerZip(corrupt)).toThrow(/checksum/u);
  });

  it("neutralizes formula-active TSV cells and decodes learner text and literal escapes", () => {
    const deck = { name: "Deck\t=1+1", cards: [
      { id: "+guid", front: "=1+1", back: "+x", source: "-1", tags: ["@tag", "review"] },
      { id: "plain", front: " \t\r=1+1", back: "\uFEFF@tag", source: "~aistudy~\"literal\"", tags: ["~aistudy~", "safe"] },
    ] };
    const tsv = exportAnkiTsv(deck);
    const trigger = /^"?[\s\p{Cc}\p{Cf}]*[=+@-]/u;
    for (const line of tsv.split("\n")) {
      expect(line.split("\t").some(cell => trigger.test(cell))).toBe(false);
    }
    expect(importAnkiTsv(tsv)).toEqual(deck);
    const legacy = ["#separator:Tab", "#html:false", "#deck:Deck", "#guid column:1", "#tags column:5",
      "#columns:GUID\tFront\tBack\tSource\tTags", "guid\t~aistudy~legacy\tback\t\t"].join("\n");
    expect(importAnkiTsv(legacy).cards[0]?.front).toBe("~aistudy~legacy");
  });

  it("rejects private fields, reserved paths and inconsistent manifests", () => {
    const note = importMarkdown("public.md", "public");
    const bundle = createLearnerPackage({ notes: [note], decks: [], reviews: [] });
    for (const key of ["SkillBeliefV1", "0109", "sealed"]) {
      expect(learnerPackageSchema.safeParse({ ...bundle, notes: [{ ...note, [key]: {} }] }).success).toBe(false);
    }
    expect(() => importObsidianNote("0109/questions.md", "question")).toThrow();
    expect(() => importMarkdown("public.md", "---\nsealed: true\n---\n")).toThrow();
    expect(() => importObsidianNote("../notes.md", "public")).toThrow();
    expect(() => exportLearnerZip({ ...bundle, manifest: { ...bundle.manifest, notes: 0 } })).toThrow();
  });

  it.each(["\n", "\r\n", "\r"])("rejects internal Opening keys in both note formats and both ZIP directions with %j", newline => {
    for (const key of [
      "workspaceId", "ownerUserId", "privacyEpoch", "memoryDependencyIds", "workspace_id", "workspace-id", "workspace id", "Workspace.ID",
      "privateAnswerKeys", "Private.Answer-Keys", "answerKey", "officialAnswers", "modelAnswer", "referenceAnswer",
      "solutionText", "hiddenRubric", "reservedItems", "privateAssessmentNotes", "trustedKey",
      "keyText", "solverAnswer", "blindSolveReceipt", "blind solve outcome", "Trusted.Question-Key-Version",
      "expectedAnswer", "canonical_answer", "referenceAnswer", "modelAnswer", "sampleSolution",
      "pinnedKey", "pinnedKeys", "teachingBlindSolveReceipt", "teachingBlindSolveReceipts", "answerBlockId",
      "answerKeyBlockIds", "publicationCardIds", "unrevealedAnswer", "unrevealedAnswers", "answerRef", "revealState",
      "costLedgerRef", "generatorModelIdentity", "modelSnapshot", "retainedQuestionEligibility", "questionEligibility",
      "correctAnswer", "correctAnswers", "workedSolution", "workedSolutions", "sampleSolutions", "canonicalAnswers",
      "expectedAnswers", "solverAnswers", "keyTexts", "trustedKeys", "teachingAnswerKeys",
      "correctOptionId", "correctOptionIds", "solution", "answer", "answerId", "evaluator", "partSnapshot",
      "resultMetadata", "questionIdentityRefId", "keyRefId", "unexposedReceipt", "lessonExposureIds",
    ]) {
      const publicKey = "x".repeat(key.length);
      const metadata = [["details:", "  - " + publicKey + ": example"]];
      if (["pinnedKey", "correctOptionId", "correctOptionIds"].includes(key)) metadata.push([publicKey + ": example"]);
      for (const lines of metadata) {
        const markdown = ["---", "title: Algebra", ...lines, "---", "# Note"].join(newline);
        const original = importObsidianNote("notes/algebra.md", markdown);
        const bundle = createLearnerPackage({ notes: [original], decks: [], reviews: [] });
        const imported = markdown.replace(publicKey, key);
        expect(() => importMarkdown(original.path, imported), key).toThrow(/YAML frontmatter/u);
        expect(() => importObsidianNote(original.path, imported), key).toThrow(/YAML frontmatter/u);
        expect(() => exportLearnerZip({ ...bundle, notes: [{ ...original, markdown: imported }] }), key).toThrow(/YAML frontmatter/u);
        const historical = replaceArchiveText(exportLearnerZip(bundle), publicKey, key);
        expect(() => importLearnerZip(historical), key).toThrow(/YAML frontmatter/u);
      }
    }
  });

  it.each(["\n", "\r\n", "\r"])("rejects schema-valid Opening records at both depths with %j line endings", newline => {
    const {
      QUESTION_IDENTITY_PROTOCOL, QUESTION_EVALUATION_PROTOCOL, questionIdentitySchema, questionIdentityMatchSchema,
      privateTrustedQuestionKeySchema, questionEvaluationSchema, questionUnexposedReceiptSchema,
      retainedQuestionEligibilitySchema, teachingBlindSolveReceiptSchema,
    } = openingContracts;
    const id = "12345678-1234-4234-8234-123456789001";
    const otherId = "12345678-1234-4234-8234-123456789002";
    const time = "2026-11-21T00:00:00.000Z";
    const source = { sourceId: id, version: 1 };
    const identity = questionIdentitySchema.parse({
      protocolVersion: QUESTION_IDENTITY_PROTOCOL, identityRefId: id,
      questionRef: { kind: "source_problem", problemId: id, sourceId: id, sourceVersion: 1 },
      sourceRefs: [source], conditionRefs: [{ kind: "source", ...source }], figureRefs: [], answerRole: "answer_key",
    });
    const receipt = {
      receiptId: id, method: "server_exact", comparatorVersion: "exact-1",
      conditions: "exact", figures: "exact", answerRole: "exact",
    };
    const comparison = { protocolVersion: QUESTION_IDENTITY_PROTOCOL, leftIdentityRefId: id, rightIdentityRefId: otherId };
    for (const result of [
      { kind: "same", receipt }, { kind: "equivalent_exact", receipt }, { kind: "candidate", basis: "semantic" },
      { kind: "unknown", reason: "missing_figures" }, { kind: "conflict", dimensions: ["conditions"] },
    ]) {
      expectPrivateRecord(questionIdentityMatchSchema.parse({ ...comparison, result }), `question identity match ${result.kind}`, newline);
    }
    const trustedKey = privateTrustedQuestionKeySchema.parse({
      keyRefId: id, identity, verification: {
        kind: "deterministic_evaluator", receiptId: id, evaluatorId: "numeric", evaluatorVersion: "1",
      },
    });
    const exposure = questionUnexposedReceiptSchema.parse({
      workspaceId: id, ownerUserId: otherId, receiptId: id, identityRefId: id, historyRevision: 0, checkedAt: time, status: "unexposed",
    });
    const part = { partId: "a", requirementKey: "fractions", identityRefId: id };
    const evaluation = questionEvaluationSchema.parse({
      protocolVersion: QUESTION_EVALUATION_PROTOCOL, evaluationRefId: otherId, questionIdentityRefId: id,
      parts: [{ ...part, outcome: "correct", assistance: "independent" }],
    });
    const blindSolve = teachingBlindSolveReceiptSchema.parse({
      protocol: "teaching-blind-solve-1",
      identity: {
        activityId: id, teachingRevisionId: id, blockId: id, contentVersion: 1, sourceVersions: { [id]: 1 },
        answerBlockId: otherId, questionText: "2 + 2?", keyText: "4",
        generatorModelIdentity: { providerId: "writer", modelName: "writer-model", family: "first" },
      },
      operationId: "solve-1", family: "second", decision: "match", solverAnswer: "4", reasonCodes: ["exact"],
      modelSnapshot: { id: "solver", providerId: "solver", modelName: "solver-model", inputCentsPerMillion: 1, outputCentsPerMillion: 2 },
      costLedgerRef: "ledger-1",
    });
    const input = { question: "2 + 2?", answer: "4", referenceText: "4", imageEvidenceRef: null };
    const dataset = gradingEvaluationDatasetSchema.parse({
      protocolVersion: "grading-evaluation-v1", datasetId: "study-fixture", datasetVersion: "1",
      cases: [{
        id: "case-1", version: "1", group: "equivalent_solution", modality: "text", input,
        candidateOutcome: "correct", candidateRationale: "Both use addition.", review: { status: "pending" },
      }],
    });
    const run = gradingEvaluationRunSchema.parse({
      datasetId: dataset.datasetId, datasetVersion: dataset.datasetVersion, modelLabel: "test-model", completedAt: time,
      provenance: "test_fixture", sourceCommit: "unknown", instructionVersion: "1", rubricVersion: "1",
      protocolVersion: "grading-evaluation-v1", promptDigest: "fixture-digest",
      results: [{ caseId: "case-1", caseVersion: "1", input, rawOutput: "correct" }],
    });
    const examParts = examQuestionPartsSchema.parse({
      questionIdentityRefId: id, packId: "practice", packVersion: "1", questionId: "q1", familyId: "arithmetic",
      parts: [{ ...part, evaluator: { kind: "choice-options-v1", correctOptionIds: ["four"] } }],
    });
    const records = {
      identity, trustedKey, exposure, evaluation, blindSolve, dataset, run, examParts,
      examResult: examPartResultSchema.parse({ questionEvaluation: evaluation }),
      eligibilityReady: retainedQuestionEligibilitySchema.parse({ status: "ready", identityStatus: "exact", trustedKey, exposure }),
      eligibilityUnknown: retainedQuestionEligibilitySchema.parse({ status: "unknown", reason: "identity_candidate" }),
      eligibilityUnavailable: retainedQuestionEligibilitySchema.parse({ status: "unavailable", reason: "stale_receipt" }),
    };
    for (const [name, record] of Object.entries(records)) expectPrivateRecord(record, name, newline);
    expectPrivateFrontmatter(["---", "status: >2-", "  unknown", 'reason: "exposure_\\', '  unknown"', "---", "# Note"].join(newline),
      "eligibility encoded in block and quoted scalars");
  });

  it.each(["\n", "\r\n", "\r"])("rejects detached question comparison results with %j line endings", newline => {
    const resultSchema = openingContracts.questionIdentityMatchSchema.shape.result;
    const results = [
      ...["semantic", "model", "unverified_reference"].map(basis => ({ kind: "candidate", basis })),
      ...["missing_identity", "missing_conditions", "missing_figures", "unavailable_reference"].map(reason => ({ kind: "unknown", reason })),
      ...["source_version", "conditions", "figures", "answer_role"].map(dimension => ({ kind: "conflict", dimensions: [dimension] })),
    ];
    for (const input of results) {
      const result = resultSchema.parse(input);
      const fields = Object.entries(result);
      const flow = JSON.stringify(result);
      const block = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
      const nextLineFlow = [...fields].reverse().flatMap(([key, value]) => [key + ":", "  " + JSON.stringify(value)]);
      const checks: Array<readonly [string, readonly string[]]> = [
        ["flow", [flow]],
        ["block", block],
        ["block with next-line flow values", nextLineFlow],
      ];
      if (result.kind === "conflict") {
        checks.push(
          ["indented sequence", ["dimensions:", "  - " + result.dimensions[0], "kind: conflict"]],
          ["indentless sequence", ["dimensions:", "- " + result.dimensions[0], "kind: conflict"]],
          ["next-line sequence item", ["kind: conflict", "dimensions:", "  -", "    '" + result.dimensions[0] + "'"]],
        );
      }
      for (const [style, lines] of checks) {
        expectPrivateFrontmatter(["---", ...lines, "---", "# Note"].join(newline), `${flow} standalone ${style}`);
        expectPrivateFrontmatter(["---", "result:", ...lines.map(line => "  " + line), "---", "# Note"].join(newline), `${flow} nested ${style}`);
      }
      expectPrivateFrontmatter(["---", "result: " + flow, "---", "# Note"].join(newline), `${flow} inline nested flow`);
    }
  });

  it("rejects other detached Opening diagnostic, tool, and checkpoint variants", () => {
    const records = {
      prerequisite: openingContracts.spanPrerequisiteQualificationSchema.parse({
        status: "unknown", reasonCode: "prerequisite_binding_missing",
      }),
      toolRequest: openingContracts.systemQueryRequestSchema.parse({ name: "exam_sprint", arguments: {} }),
      proposal: openingContracts.assistantProposalToolSchema.parse({
        name: "propose_note", arguments: { title: "Draft", text: "Private proposal" },
      }),
      toolTrace: openingContracts.providerToolMessageSchema.parse({
        role: "assistant", calls: [{ id: "call-1", name: "notes", arguments: "{}" }],
      }),
      checkpoint: openingContracts.teachingCheckpointSaveResultSchema.parse({
        ok: true, contentVersion: 1, checkpointJson: {},
      }),
      quota: openingContracts.openingDailyQuotaSchema.parse({ mode: "limited", capCents: 10 }),
    };
    for (const [name, record] of Object.entries(records)) expectPrivateRecord(record, name, "\n");
    expectPrivateFrontmatter("---\nkind: conflict\ndimensions: [scheduling, source_version]\n---\n# Note", "matching element after an unrelated one");
  });

  it("finds private markers across the required shapes of exported Opening schemas", () => {
    const openingSchemas: Record<string, unknown> = {
      ...openingContracts, examPartResultSchema, examQuestionPartsSchema, gradingEvaluationDatasetSchema, gradingEvaluationRunSchema,
    };
    const privateRecord = /receipt|identity|evaluation|eligibility|grading|prediction|telemetry|belief|snapshot|exposure|usage|trusted|examQuestionParts|examPartResult/iu;
    // These public/reference projections have the same required shape as
    // ordinary note metadata. Inspect their private fields in context instead.
    const sharedShapes = new Set(["aiGradingWorkSourceSchema", "learningAssetIdentitySchema", "knowledgeSnapshotSchema", "storedKnowledgeSnapshotSchema"]);
    const inspected: string[] = [];
    for (const [name, schema] of Object.entries(openingSchemas)) {
      if (!(schema instanceof z.ZodObject || schema instanceof z.ZodUnion) || !privateRecord.test(name) || sharedShapes.has(name)) continue;
      const json = z.toJSONSchema(schema, { unrepresentable: "any" });
      for (const shape of json.oneOf ?? json.anyOf ?? [json]) {
        if (shape.type !== "object") continue;
        // Required field probes complement the schema-valid fixtures above.
        // Use literal and enum discriminators for variants with generic field names.
        const record = Object.fromEntries((shape.required ?? []).map(key => {
          const field = shape.properties?.[key];
          return [key, typeof field === "object" ? field.const ?? field.enum?.[0] ?? true : true];
        }));
        for (const newline of ["\n", "\r\n", "\r"]) expectPrivateRecord(record, name, newline);
        inspected.push(name);
      }
    }
    expect(inspected).toEqual(expect.arrayContaining([
      "questionIdentityMatchSchema", "privateTrustedQuestionKeySchema", "retainedQuestionEligibilitySchema",
      "teachingBlindSolveReceiptSchema", "studyExposureReceiptSchema", "gradingEvaluationRunSchema",
      "importReceiptSchema", "dayAdjustmentDaySnapshotSchema", "openingAiDailyUsageSchema",
    ]));
    for (const record of [{ workSource: { id: "fixture", version: 1, physicalPage: 2 } }, { coveredSourceChunkDigests: {} }]) {
      expectPrivateRecord(record, "private fields of shared projections", "\n");
    }
  });

  it.each(["\u2028", "\u2029"])("rejects internal metadata across ambiguous YAML separators %j", newline => {
    for (const importNote of [importMarkdown, importObsidianNote]) {
      const path = "notes/algebra.md";
      for (const key of ["workspaceId", "keyText", "solverAnswer", "title"]) {
        expect(() => importNote(path, ["---", key + ": example", "---", "# Note"].join(newline))).toThrow(/YAML frontmatter/u);
        expect(() => importNote(path, "---\ntitle: example" + newline + key + ": hidden\n---\n# Note")).toThrow(/YAML frontmatter/u);
      }
      const markdown = "---\ntitle: example\n---\n# Note" + newline + "Paragraph";
      const bundle = createLearnerPackage({ notes: [importNote(path, markdown)], decks: [], reviews: [] });
      expect(importLearnerZip(exportLearnerZip(bundle)).notes[0]?.markdown).toBe(markdown);
    }
  });

  it.each([
    "{ sealed: true }",
    '"sealed": true',
    "'sealed': true",
    'parent: {\n  "se\\u0061led": true,\n}',
    "parent:\n  - public: true\n    sealed: true",
    "{ public: [one, two }",
    "title: first\ntitle: duplicate",
    'title: first\n"t\\u0069tle": duplicate',
    "alias: *unresolved",
  ])("fails closed on private or malformed frontmatter (%s)", frontmatter => {
    const markdown = `---\n${frontmatter}\n---\n# Note\n`;
    expect(() => importMarkdown("note.md", markdown)).toThrow(/YAML frontmatter/u);
    expect(() => importObsidianNote("note.md", markdown)).toThrow(/YAML frontmatter/u);
    const bundle = createLearnerPackage({ notes: [importMarkdown("note.md", "# Note\n")], decks: [], reviews: [] });
    bundle.notes[0]!.markdown = markdown;
    expect(() => exportLearnerZip(bundle)).toThrow(/YAML frontmatter/u);
  });

  it.each([
    ["inline fence with a line separator", '--- { title: "a\u2028b", sealed: true }\n---\n# note'],
    ["commented document start", "---\n--- # metadata\nsealed: true\n---\n# note"],
    ["commented document end", "---\n... # metadata\nsealed: true\n---\n# note"],
    ["numeric key aliases", "---\n16: first\n0x10: second\n---\n# note"],
    ["boolean key aliases", "---\ntrue: first\nTRUE: second\n---\n# note"],
    ["Unicode line breaks in metadata", '---\ntitle: "a\u0085b\u2029c"\n---\n# note'],
    ["private CR-only mapping", "---\rsealed: true\r---\r# Note"],
    ["ambiguous CR-only mapping", "---\r16: first\r0x10: second\r---\r# Note"],
    ["private keys through ordinary objects", "---\n{ __proto__: { constructor: [{ Skill Belief V1: true }] } }\n---\n"],
  ])("rejects ambiguous frontmatter with %s", (_description, markdown) => {
    expect(() => importMarkdown("note.md", markdown)).toThrow(/YAML frontmatter/u);
    expect(() => importObsidianNote("note.md", markdown)).toThrow(/YAML frontmatter/u);
    const bundle = createLearnerPackage({ notes: [importMarkdown("note.md", "# Note\n")], decks: [], reviews: [] });
    bundle.notes[0]!.markdown = markdown;
    expect(() => exportLearnerZip(bundle)).toThrow(/YAML frontmatter/u);
  });

  it.each(["16", "0x10", "0o20", "0b10000", "-1", "3.14", "1_000", "2026-11-21", "true", "yes", "null", "~", "<<", "+.inf", ".nan"])(
    "rejects ambiguous unquoted scalar key %s", key => {
      expect(() => importMarkdown("note.md", "---\n" + key + ": value\n---\n")).toThrow(/YAML frontmatter/u);
    },
  );

  it.each(["\n", "\r", "\r\n"])("round-trips public frontmatter with %j line endings", newline => {
    const markdown = ["\uFEFF---", "课程: 数学", "course name: Algebra", 'details: { "yes": "string", 学习 进度: 3 }',
      "title: Matrix", "tags: [math]", "aliases: [Algebra]", "created: 2026-11-20", "updated: 2026-11-21",
      "summary: Practice", "course: Math", "deck: Algebra", "author: Learner", "lang: en", "id: note-1",
      'properties: { "16": first, "0x10": second }', "items: [Matrix]",
      "date: 2026-11-21", "status: unknown", "reason: researching", "type: study", 'url: "https://example.invalid"',
      "description: Study note", "version: 1", "label: Open", "topic: Algebra", "chapter: 2", "source: Textbook",
      "---", "# 课程", ""].join(newline);
    const note = importObsidianNote("note.md", markdown);
    expect(exportObsidianNote(note).markdown).toBe(markdown);
    expect(exportMarkdown(importMarkdown(note.path, markdown))).toBe(markdown);
    const archive = exportLearnerZip(createLearnerPackage({ notes: [note], decks: [], reviews: [] }));
    expect(importLearnerZip(archive).notes.map(exportMarkdown)).toEqual([markdown]);
  });

  it.each(["\n", "\r\n", "\r"])("round-trips quoted and explicitly indented scalars with %j line endings", newline => {
    const markdown = [
      "---", 'title: "Line 1', '  Line 2"', "description: 'It''s line 1",
      "  Line 2'", 'summary: "Joined \\', '  line 2"', "details:", "  literal: |2- # two spaces",
      "    ReceiptId: sample text", "  reverse: |-2", "    First line", "    Second line", "  folded: >2+",
      "    Fold this", "    paragraph", "", "items:", '  - "Line 1', '   Line 2"', "---", "# Note", "",
    ].join(newline);
    expectPortableFrontmatter(markdown);
  });

  it.each(["\n", "\r\n", "\r"])("round-trips next-line scalars and dedented block-scalar comments with %j line endings", newline => {
    const markdown = [
      "---", "title:", '  "Line 1', '  Line 2"', "description:", "  'First", "  second'",
      "topic:", "  Plain multiline", "", "  text", "summary:", "  |2-", "  \ttabbed text", " # trailing comment", "next: ok",
      "inline: |2-", "  \tinline tabbed text", " # trailing inline scalar comment",
      "properties:", "  auto: |-", "    # literal leading line", "    \ttabbed", "   # trailing comment", "  next: ok",
      "  empty: |-", "  # comment before any content", "  final: ok",
      "items:", "  -", "    |2-", "    body", "  -", "    >2-", "    folded", "    text",
      "  -", "    plain sequence item", "    continuation", "  -", "    'Quoted", "    continuation'",
      "---", "# Note", "",
    ].join(newline);
    expectPortableFrontmatter(markdown);
  });

  it("preserves unrelated public values for comparison field names", () => {
    expectPortableFrontmatter([
      "---", "result: { kind: conflict, dimensions: [schedule] }", "candidate: { kind: candidate, basis: outline }",
      "other: { kind: unknown, reason: researching }", "first: { kind: candidate }", "second: { basis: semantic }",
      "nested: { kind: conflict, dimensions: [[source_version]] }", "toolNotes: { name: notes, arguments: general }",
      "workLog: { role: assistant, calls: 5 }", "progress: { status: pending }", "---", "# Note",
    ].join("\n"));
  });

  it.each([
    ["zero indentation indicator", "summary: |0\n  note"],
    ["two indentation indicators", "summary: |22\n  note"],
    ["two chomping indicators", "summary: |--\n  note"],
    ["joined block comment", "summary: |2-# comment\n  note"],
    ["under-indented block scalar", "details:\n  summary: |2-\n   note"],
    ["under-indented quoted scalar", 'details:\n  title: "Part one\n  Part two"'],
    ["under-indented escaped newline", 'details:\n  title: "Part one\\\n  Part two"'],
    ["multiline implicit key", '"course\n  name": Algebra'],
    ["escaped newline in implicit key", '"course\\\n  name": Algebra'],
    ["tab used as block indentation", "summary: |2-\n \ttabbed text"],
    ["tab used as auto-detected block indentation", "summary: |-\n\ttabbed text"],
    ["comment before a plain continuation", "title: first\n # comment\n  second"],
  ])("rejects %s in frontmatter", (name, metadata) => {
    expectPrivateFrontmatter(`---\n${metadata}\n---\n# Note`, name);
  });

  it("keeps valid flow and block frontmatter byte-for-byte through ZIP", () => {
    const flow = '\uFEFF--- \t\r\n{ "title": "Note", "16": first, "0x10": second, properties: { tags: [math, "algebra"] } }\r\n... \t\r\n# Matrix\u2028\r\n';
    const block = "---\nitems:\n- title: 'Matrix'\n  tags:\n    - math\nsummary: |\n  sealed: true is an example, not a field.\n---\n# Matrix\n";
    const notes = [importMarkdown("flow.md", flow), importObsidianNote("block.md", block)];
    const bundle = createLearnerPackage({ notes, decks: [], reviews: [] });
    expect(importLearnerZip(exportLearnerZip(bundle)).notes.map(exportMarkdown)).toEqual([flow, block]);
    expect(() => importMarkdown("open.md", "---\ntitle: missing end\n")).toThrow(/YAML frontmatter/u);
    expect(() => importMarkdown("inline.md", "--- { sealed: true }\n---\n")).toThrow(/YAML frontmatter/u);
  });
});

describe("lite cartridges", () => {
  const cartridge = {
    version: 1, id: "addition", title: "Practice", level: "L2", items: [
      { id: "sum", prompt: "1+1", criterion: { label: "Compute the sum", points: 2 },
        kind: "exact_text", accepted: ["2"], comparison: "trim" },
      { id: "pick", prompt: "Pick an even number", criterion: { label: "Recognize even numbers", points: 3 },
        kind: "single_choice", choices: [{ id: "a", label: "1" }, { id: "b", label: "2" }], answerId: "b" },
    ],
  };

  it("grades declarative items with deterministic per-criterion points", () => {
    expect(validateCartridgeLite(cartridge).ok).toBe(true);
    expect(executeCartridgeLite(cartridge, { sum: " 2 ", pick: "a" })).toEqual({
      status: "graded", earnedPoints: 2, possiblePoints: 5, items: [
        { id: "sum", criterion: "Compute the sum", correct: true, earnedPoints: 2, possiblePoints: 2 },
        { id: "pick", criterion: "Recognize even numbers", correct: false, earnedPoints: 0, possiblePoints: 3 },
      ],
    });
    expect(executeCartridgeLite(cartridge, { unknown: "2" })).toEqual({ status: "invalid_answers" });
    expect(validateCartridgeLite({ ...cartridge, items: [cartridge.items[0], cartridge.items[0]] })).toEqual({ ok: false, code: "invalid_cartridge" });
  });

  it.each(["L3", "L4"])("rejects %s and closed recipe capabilities", level => {
    expect(validateCartridgeLite({ ...cartridge, level })).toEqual({ ok: false, code: "unsupported_level" });
    expect(queryCartridgeLiteCapability(level)).toEqual({ status: "unsupported_level" });
    expect(executeCartridgeLite({ ...cartridge, level }, {})).toEqual({ status: "unsupported_level" });
    const advancedItem = { ...cartridge, items: [{ ...cartridge.items[0], level }, cartridge.items[1]] };
    expect(validateCartridgeLite(advancedItem)).toEqual({ ok: false, code: "unsupported_level" });
    expect(executeCartridgeLite(advancedItem, {})).toEqual({ status: "unsupported_level" });
    expect(executeCartridgeLite({ ...cartridge, capabilities: ["SeededRecipe"] }, {})).toEqual({ status: "unavailable" });
  });
});
