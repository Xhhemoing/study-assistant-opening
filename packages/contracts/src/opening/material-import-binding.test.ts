import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalMaterialImportAnswerContent, canonicalMaterialImportQuestionContent,
  computeMaterialImportContentHashes, materialImportAnswerContentSchema,
  materialImportBindingInputSchema, materialImportQuestionContentSchema,
  type MaterialImportBindingInput,
} from "./material-import-binding";

const sourceId = "10000000-0000-4000-8000-000000000001";
const chunkId = "10000000-0000-4000-8000-000000000002";
const sourceSha256 = "a".repeat(64);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(): MaterialImportBindingInput {
  const locator = { sourceId, sourceVersion: 2, sourceSha256, chunkId, physicalPage: 4, printedLabel: "iii", textRange: { start: 0, end: 20 } };
  return {
    schemaVersion: 1, sourceId, sourceVersion: 2, sourceSha256, expectedManifestRevision: 0,
    mappingId: "10000000-0000-4000-8000-000000000003", questionId: "10000000-0000-4000-8000-000000000004",
    question: { locator, content: { schemaVersion: 1, contentVersion: 0, stem: "计算 1+1", interaction: { kind: "numeric", unit: "个" } } },
    answer: { locator: { ...locator, textRange: { start: 21, end: 22 } }, content: { schemaVersion: 1, contentVersion: 0, role: "answer_key", text: "2" } },
    manualConfirmation: { method: "manual_transcription", confirmed: true },
  };
}
function choice() {
  return { ...fixture().question.content, interaction: { kind: "choice" as const, options: [{ id: "A", label: "甲" }, { id: "B", label: "乙" }] } };
}

describe("private manual material import input", () => {
  it("accepts exactly one mapping and separates physical page from printed label", () => {
    const input = fixture();
    expect(materialImportBindingInputSchema.parse(input)).toEqual(input);
    input.question.locator.physicalPage = null;
    input.answer.locator.physicalPage = null;
    input.question.locator.printedLabel = "第150题";
    input.answer.locator.printedLabel = "第150题";
    const parsed = materialImportBindingInputSchema.parse(input);
    expect(parsed.question.locator.physicalPage).toBeNull();
    expect(parsed.question.locator.printedLabel).toBe("第150题");
  });

  it.each(["owner", "ownerUserId", "workspaceId", "courseId", "reviewer", "reviewedBy", "reviewedAt", "grant", "eligible", "independent", "coverage", "firstAnswerProjection", "mappings"])("rejects client authority/batch field %s", key => {
    expect(materialImportBindingInputSchema.safeParse({ ...fixture(), [key]: true }).success).toBe(false);
  });

  it.each(["question", "answer", "locator", "content", "interaction", "textRange", "manualConfirmation", "option"])("rejects nested extras at %s", level => {
    const input = fixture();
    let target: object;
    switch (level) {
      case "question": target = input.question; break;
      case "answer": target = input.answer; break;
      case "locator": target = input.answer.locator; break;
      case "content": target = input.question.content; break;
      case "interaction": target = input.question.content.interaction; break;
      case "textRange": target = input.question.locator.textRange; break;
      case "option": input.question.content = choice(); target = input.question.content.interaction.kind === "choice" ? input.question.content.interaction.options[0]! : {}; break;
      default: target = input.manualConfirmation;
    }
    Object.assign(target, { eligible: true });
    expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["schemaVersion", 2], ["mappingId", "question-150"], ["questionId", "150"],
    ["sourceVersion", -1], ["sourceVersion", 0.5], ["expectedManifestRevision", -1],
    ["expectedManifestRevision", Number.MAX_SAFE_INTEGER + 1], ["sourceSha256", "wrong"],
  ])("rejects invalid %s=%s", (key, value) => {
    expect(materialImportBindingInputSchema.safeParse({ ...fixture(), [key]: value }).success).toBe(false);
  });

  it.each(["question", "answer"] as const)("rejects %s source/version/SHA mismatch rather than discarding it", part => {
    for (const patch of [{ sourceId: chunkId }, { sourceVersion: 1 }, { sourceSha256: "b".repeat(64) }]) {
      const input = fixture();
      Object.assign(input[part].locator, patch);
      expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("normalizes digest casing, but does not claim a source hash is authenticated", async () => {
    const input = fixture();
    input.sourceSha256 = input.question.locator.sourceSha256 = input.answer.locator.sourceSha256 = "B".repeat(64);
    const parsed = materialImportBindingInputSchema.parse(input);
    expect(parsed.sourceSha256).toBe("b".repeat(64));
    // Arbitrary source SHA remains unverified; this helper only computes CONTENT hashes.
    expect(await computeMaterialImportContentHashes(input, sha256)).toEqual(await computeMaterialImportContentHashes(fixture(), sha256));
  });

  it.each([
    { chunkId: "fake" }, { physicalPage: 0 }, { physicalPage: "iii" },
    { textRange: { start: 10, end: 10 } }, { textRange: { start: -1, end: 2 } },
    { textRange: { start: 4, end: 2 } }, { printedLabel: "" },
    { page: 4 }, { sourceVersion: undefined }, { chunkId: undefined }, { physicalPage: undefined },
  ])("rejects invalid locator combination %j", patch => {
    const input = fixture();
    Object.assign(input.question.locator, patch);
    expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects conflicting metadata/overlap in one chunk but accepts separate ranges/chunks", () => {
    for (const patch of [{ physicalPage: 5 }, { printedLabel: "iv" }, { textRange: { start: 19, end: 22 } }]) {
      const input = fixture();
      Object.assign(input.answer.locator, patch);
      expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    }
    const separate = fixture();
    separate.answer.locator.chunkId = separate.mappingId;
    separate.answer.locator.physicalPage = 5;
    separate.answer.locator.textRange = { start: 0, end: 1 };
    expect(materialImportBindingInputSchema.safeParse(separate).success).toBe(true);
  });

  it("requires explicit confirmation, supported interaction, version and answer_key role", () => {
    for (const patch of [{ confirmed: false }, { method: "auto" }, { confirmed: undefined }]) {
      const input = fixture();
      Object.assign(input.manualConfirmation, patch);
      expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    }
    for (const patch of [{ role: "example" }, { role: "verified" }, { contentVersion: -1 }, { schemaVersion: 2 }, { text: " " }]) {
      expect(materialImportAnswerContentSchema.safeParse({ ...fixture().answer.content, ...patch }).success).toBe(false);
    }
    for (const interaction of [{ kind: "text" }, { kind: "numeric", options: [] }, { kind: "choice", unit: "cm", options: [] }]) {
      expect(materialImportQuestionContentSchema.safeParse({ ...fixture().question.content, interaction }).success).toBe(false);
    }
  });

  it.each(["root", "nested", "unknown", "array"])("rejects %s accessor without calling it", level => {
    const getter = vi.fn(() => { throw new Error("must not execute"); });
    const input = fixture();
    let target: object = input;
    let key = "sourceId";
    if (level === "nested") { target = input.answer.locator; key = "chunkId"; }
    if (level === "unknown") key = "grant";
    if (level === "array") { input.question.content = choice(); target = input.question.content.interaction.kind === "choice" ? input.question.content.interaction.options : []; key = "0"; }
    Object.defineProperty(target, key, { enumerable: true, configurable: true, get: getter });
    expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    expect(() => canonicalMaterialImportQuestionContent(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects exotic data, cycles, symbols and non-enumerable properties", () => {
    const cycle = fixture(); Object.assign(cycle.question, { cycle });
    const symbol = fixture(); Object.assign(symbol, { [Symbol("owner")]: "forged" });
    const hidden = fixture(); Object.defineProperty(hidden.answer, "grant", { value: true });
    const inherited = Object.assign(Object.create({ grant: true }), fixture());
    for (const input of [cycle, symbol, hidden, inherited, new Date(), undefined, null]) {
      expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects oversize text, collections and sparse arrays before digest execution", async () => {
    const inputs = [fixture(), fixture(), fixture(), fixture()];
    inputs[0]!.question.content.stem = "x".repeat(8_001);
    inputs[1]!.answer.content.text = "x".repeat(20_001);
    inputs[2]!.question.content = { ...choice(), interaction: { kind: "choice", options: Array.from({ length: 7 }, (_, i) => ({ id: String(i), label: "x" })) } };
    inputs[3]!.question.content = { ...choice(), interaction: { kind: "choice", options: new Array(100_000) } };
    const digest = vi.fn(sha256);
    for (const input of inputs) {
      await expect(computeMaterialImportContentHashes(input, digest)).rejects.toThrow();
    }
    expect(digest).not.toHaveBeenCalled();
  });
});

describe("canonical UTF-8 content and server digest seam", () => {
  it("has a fixed byte vector, UTF-8 byte lengths, domain separation and repeatable SHA", async () => {
    const input = fixture();
    const bytes = canonicalMaterialImportQuestionContent(input.question.content);
    expect(new TextDecoder().decode(bytes)).toBe("26:material-import-question-1,1:1,1:0,10:计算 1+1,7:numeric,1:1,3:个,");
    expect(new TextDecoder().decode(canonicalMaterialImportAnswerContent(input.answer.content)))
      .toBe("24:material-import-answer-1,1:1,1:0,10:answer_key,1:2,");
    const first = await computeMaterialImportContentHashes(input, sha256);
    expect(first).toEqual(await computeMaterialImportContentHashes(input, async bytes => sha256(bytes).toUpperCase()));
    expect(first.questionContentSha256).toBe(sha256(bytes));
    expect(first.questionContentSha256).not.toBe(first.answerContentSha256);
  });

  it("ignores object key insertion order, never option order", () => {
    const content = choice();
    const reordered = { interaction: { options: content.interaction.options.map(({ id, label }) => ({ label, id })), kind: "choice" }, stem: content.stem, contentVersion: 0, schemaVersion: 1 };
    expect(canonicalMaterialImportQuestionContent(reordered)).toEqual(canonicalMaterialImportQuestionContent(content));
    const reversed = { ...content, interaction: { ...content.interaction, options: [...content.interaction.options].reverse() } };
    expect(canonicalMaterialImportQuestionContent(reversed)).not.toEqual(canonicalMaterialImportQuestionContent(content));
  });

  it("normalizes CRLF and lone CR everywhere, preserving spaces, LF and Unicode forms", () => {
    const q = fixture().question.content;
    expect(canonicalMaterialImportQuestionContent({ ...q, stem: "a\r\nb\rc\n", interaction: { kind: "numeric", unit: "m\r\ns" } }))
      .toEqual(canonicalMaterialImportQuestionContent({ ...q, stem: "a\nb\nc\n", interaction: { kind: "numeric", unit: "m\ns" } }));
    const a = fixture().answer.content;
    expect(canonicalMaterialImportAnswerContent({ ...a, text: "a\r\nb\r" })).toEqual(canonicalMaterialImportAnswerContent({ ...a, text: "a\nb\n" }));
    for (const [left, right] of [[" a", "a"], ["a\n", "a"], ["é", "e\u0301"], ["a,b:c", "a,b:c\n"]]) {
      expect(canonicalMaterialImportAnswerContent({ ...a, text: left })).not.toEqual(canonicalMaterialImportAnswerContent({ ...a, text: right }));
    }
    const c = choice();
    expect(canonicalMaterialImportQuestionContent({ ...c, interaction: { kind: "choice", options: [{ id: "A\r\n", label: "甲\r" }, { id: "B", label: "乙" }] } }))
      .toEqual(canonicalMaterialImportQuestionContent({ ...c, interaction: { kind: "choice", options: [{ id: "A\n", label: "甲\n" }, { id: "B", label: "乙" }] } }));
  });

  it("rejects invalid Unicode and option IDs that collide after newline normalization", () => {
    for (const text of ["\ud800", "\udc00", "x\ud800x"]) {
      expect(() => canonicalMaterialImportQuestionContent({ ...fixture().question.content, stem: text })).toThrow();
      expect(() => canonicalMaterialImportAnswerContent({ ...fixture().answer.content, text })).toThrow();
    }
    expect(() => canonicalMaterialImportQuestionContent({ ...choice(), interaction: { kind: "choice", options: [{ id: "A\r", label: "甲" }, { id: "A\n", label: "乙" }] } })).toThrow();
    expect(() => canonicalMaterialImportQuestionContent({ ...fixture().question.content, interaction: { kind: "numeric", unit: "\ud800" } })).toThrow();
  });

  it("binds contentVersion, stem, kind, unit presence, option IDs/labels and answer role/text", async () => {
    const q = fixture().question.content;
    const baseline = canonicalMaterialImportQuestionContent(q);
    for (const changed of [{ ...q, contentVersion: 1 }, { ...q, stem: "new" }, choice(), { ...q, interaction: { kind: "numeric" } }]) {
      expect(canonicalMaterialImportQuestionContent(changed)).not.toEqual(baseline);
    }
    expect(canonicalMaterialImportQuestionContent({ ...q, interaction: { kind: "numeric" } }))
      .not.toEqual(canonicalMaterialImportQuestionContent({ ...q, interaction: { kind: "numeric", unit: "" } }));
    const c = choice();
    for (const patch of [{ id: "C" }, { label: "丙" }]) {
      expect(canonicalMaterialImportQuestionContent({ ...c, interaction: { ...c.interaction, options: [{ ...c.interaction.options[0]!, ...patch }, c.interaction.options[1]!] } }))
        .not.toEqual(canonicalMaterialImportQuestionContent(c));
    }
    const a = fixture().answer.content;
    expect(canonicalMaterialImportAnswerContent({ ...a, contentVersion: 1 })).not.toEqual(canonicalMaterialImportAnswerContent(a));
    expect(canonicalMaterialImportAnswerContent({ ...a, text: "3" })).not.toEqual(canonicalMaterialImportAnswerContent(a));
    expect(() => canonicalMaterialImportAnswerContent({ ...a, role: "teach" })).toThrow();
  });

  it("compares optional expected hashes to their own content, never source SHA or the other side", async () => {
    const input = fixture();
    const hashes = await computeMaterialImportContentHashes(input, sha256);
    input.question.expectedContentSha256 = hashes.questionContentSha256.toUpperCase();
    input.answer.expectedContentSha256 = hashes.answerContentSha256;
    expect(await computeMaterialImportContentHashes(input, sha256)).toEqual(hashes);
    input.question.expectedContentSha256 = sourceSha256;
    await expect(computeMaterialImportContentHashes(input, sha256)).rejects.toThrow("Question content SHA-256 mismatch");
    input.question.expectedContentSha256 = hashes.questionContentSha256;
    input.answer.expectedContentSha256 = hashes.questionContentSha256;
    await expect(computeMaterialImportContentHashes(input, sha256)).rejects.toThrow("Answer content SHA-256 mismatch");
  });

  it("propagates server digest failure and rejects malformed digest results", async () => {
    await expect(computeMaterialImportContentHashes(fixture(), () => { throw new Error("digest unavailable"); })).rejects.toThrow("digest unavailable");
    await expect(computeMaterialImportContentHashes(fixture(), () => "not-a-hash")).rejects.toThrow();
    await expect(computeMaterialImportContentHashes(fixture(), async () => { throw new Error("async digest unavailable"); })).rejects.toThrow("async digest unavailable");
  });
});


describe("array own-key boundary regression", () => {
  it.each(["4294967295", "9007199254740991", "999999999999999999999999999999", "01", "-1"])("rejects named numeric-looking property %s before digest", async key => {
    const input = fixture();
    input.question.content = choice();
    const options = input.question.content.interaction.kind === "choice" ? input.question.content.interaction.options : [];
    Object.defineProperty(options, key, { value: { permissions: ["grant"], eligible: true }, enumerable: true });
    expect(materialImportBindingInputSchema.safeParse(input).success).toBe(false);
    let calls = 0;
    await expect(computeMaterialImportContentHashes(input, () => { calls++; return sourceSha256; })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
