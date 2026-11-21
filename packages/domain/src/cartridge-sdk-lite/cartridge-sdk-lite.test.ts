import { describe, expect, it } from "vitest";
import { learnerPackageSchema } from "@aistudy/contracts/learner-portability";
import {
  createLearnerPackage, createPortableReview, executeCartridgeLite, exportAnkiTsv, exportLearnerZip,
  exportMarkdown, exportObsidianNote, importAnkiTsv, importLearnerZip, importMarkdown, importObsidianNote,
  queryCartridgeLiteCapability, schedulePortableReview, validateCartridgeLite,
} from "./index";

function changeZipKey(archive: Uint8Array, before: string, after: string): Uint8Array {
  const headers = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const start = 30 + headers.getUint16(26, true) + headers.getUint16(28, true);
  const end = start + headers.getUint32(18, true);
  const payload = archive.subarray(start, end);
  const text = new TextDecoder().decode(payload);
  const offset = text.indexOf(before);
  expect(offset).toBeGreaterThanOrEqual(0);
  const encoder = new TextEncoder();
  payload.set(encoder.encode(after), encoder.encode(text.slice(0, offset)).length);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  headers.setUint32(14, crc ^ 0xffffffff, true);
  headers.setUint32(end + 16, crc ^ 0xffffffff, true);
  return archive;
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
    ]) {
      const publicKey = "x".repeat(key.length);
      const markdown = ["---", "title: Algebra", "details:", "  - " + publicKey + ": example", "---", "# Note"].join(newline);
      const original = importObsidianNote("notes/algebra.md", markdown);
      const bundle = createLearnerPackage({ notes: [original], decks: [], reviews: [] });
      const imported = markdown.replace(publicKey, key);
      expect(() => importMarkdown(original.path, imported)).toThrow(/YAML frontmatter/u);
      expect(() => importObsidianNote(original.path, imported)).toThrow(/YAML frontmatter/u);
      expect(() => exportLearnerZip({ ...bundle, notes: [{ ...original, markdown: imported }] })).toThrow(/YAML frontmatter/u);
      const historical = changeZipKey(exportLearnerZip(bundle), publicKey, key);
      expect(() => importLearnerZip(historical)).toThrow(/YAML frontmatter/u);
    }
  });

  it.each(["\u2028", "\u2029"])("rejects internal metadata across ambiguous YAML separators %j", newline => {
    for (const importNote of [importMarkdown, importObsidianNote]) {
      expect(() => importNote("notes/algebra.md", ["---", "workspaceId: example", "---", "# Note"].join(newline))).toThrow(/YAML frontmatter/u);
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

  it.each(["\n", "\r", "\r\n"])("round-trips Unicode and spaced public keys with %j line endings", newline => {
    const markdown = ["\uFEFF---", "课程: 数学", "course name: Algebra", 'details: { "yes": "string", 学习 进度: 3 }',
      "---", "# 课程", ""].join(newline);
    const note = importObsidianNote("note.md", markdown);
    expect(exportMarkdown(importMarkdown(note.path, markdown))).toBe(markdown);
    const archive = exportLearnerZip(createLearnerPackage({ notes: [note], decks: [], reviews: [] }));
    expect(importLearnerZip(archive).notes.map(exportMarkdown)).toEqual([markdown]);
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
