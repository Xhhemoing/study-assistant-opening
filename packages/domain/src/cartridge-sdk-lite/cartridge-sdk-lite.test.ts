import { describe, expect, it } from "vitest";
import { learnerPackageSchema } from "@aistudy/contracts/learner-portability";
import {
  createLearnerPackage, createPortableReview, executeCartridgeLite, exportAnkiTsv, exportLearnerZip,
  exportMarkdown, exportObsidianNote, importAnkiTsv, importLearnerZip, importMarkdown, importObsidianNote,
  queryCartridgeLiteCapability, schedulePortableReview, validateCartridgeLite,
} from "./index";

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
    expect(executeCartridgeLite({ ...cartridge, capabilities: ["SeededRecipe"] }, {})).toEqual({ status: "unavailable" });
  });
});
