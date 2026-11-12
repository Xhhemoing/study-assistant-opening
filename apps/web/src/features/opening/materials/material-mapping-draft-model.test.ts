import { describe, expect, it } from "vitest";
import { materialImportBindingInputSchema } from "@aistudy/contracts";
import { buildMappingDraft, emptyMappingDraftFields, mappingDraftMetadataSchema, type MappingDraftMetadata } from "./material-mapping-draft-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const metadata = (): MappingDraftMetadata => ({ actorKey: "synthetic", inputResetKey: "r1", sourceId: id(1), sourceVersion: 0,
  sourceSha256: "A".repeat(64), expectedManifestRevision: 0, mappingId: id(2), questionId: id(3), questionContentVersion: 0, answerContentVersion: 0,
  chunks: [{ chunkId: id(4), physicalPage: null, printedLabel: null, textLength: 100 }] });
const fields = () => ({ ...emptyMappingDraftFields(), confirmed: true, stem: "question\r\n", answer: "answer\r", questionChunk: id(4), answerChunk: id(4),
  questionStart: "0", questionEnd: "10", answerStart: "10", answerEnd: "20" });

describe("metadata own-data boundary", () => {
  it.each([false, true])("rejects root and nested accessors without calling them (throws=%s)", throws => {
    for (const nested of [false, true]) {
      const input = metadata(); let reads = 0;
      Object.defineProperty(nested ? input.chunks[0]! : input, nested ? "printedLabel" : "actorKey", {
        enumerable: true, get() { reads++; if (throws) throw new Error("PRIVATE_ACCESSOR_ERROR_CANARY"); return "PRIVATE_ACCESSOR_VALUE_CANARY"; },
      });
      expect(() => mappingDraftMetadataSchema.safeParse(input)).not.toThrow();
      expect(mappingDraftMetadataSchema.safeParse(input).success).toBe(false); expect(reads).toBe(0);
    }
  });
  it("accepts all 1000 chunks with maximum metadata strings, snapshots without mutating input", () => {
    const input = metadata(); input.actorKey = "a".repeat(200); input.inputResetKey = "r".repeat(200);
    input.chunks = Array.from({ length: 1000 }, (_, i) => ({ chunkId: id(i + 4), physicalPage: i + 1, printedLabel: "p".repeat(120), textLength: 100 }));
    const before = JSON.stringify(input), parsed = mappingDraftMetadataSchema.parse(input);
    expect(parsed).toEqual(input); expect(parsed).not.toBe(input); expect(parsed.chunks[999]).not.toBe(input.chunks[999]);
    input.chunks[999]!.printedLabel = "changed"; expect(parsed.chunks[999]!.printedLabel).toBe("p".repeat(120));
    input.chunks[999]!.printedLabel = "p".repeat(120); expect(JSON.stringify(input)).toBe(before);
    const form = { ...fields(), questionChunk: id(1003), answerChunk: id(1003) };
    expect(buildMappingDraft(parsed, form)).not.toBeNull();
  });
  it("accepts plain null-prototype own records but rejects inherited fields and custom prototypes", () => {
    const input = metadata(); Object.setPrototypeOf(input, null); Object.setPrototypeOf(input.chunks[0]!, null);
    expect(mappingDraftMetadataSchema.safeParse(input).success).toBe(true);
    expect(mappingDraftMetadataSchema.safeParse(Object.create(metadata())).success).toBe(false);
    const nested = metadata(); Object.setPrototypeOf(nested.chunks[0]!, { inherited: true });
    expect(mappingDraftMetadataSchema.safeParse(nested).success).toBe(false);
    const array = metadata(); Object.setPrototypeOf(array.chunks, Object.create(Array.prototype));
    expect(mappingDraftMetadataSchema.safeParse(array).success).toBe(false);
  });
  it("rejects oversize chunks/strings, sparse arrays, array extras and unsupported own descriptors", () => {
    const cases: unknown[] = [];
    const oversize = metadata(); oversize.chunks = Array.from({ length: 1001 }, (_, i) => ({ ...oversize.chunks[0]!, chunkId: id(i + 4) })); cases.push(oversize);
    cases.push({ ...metadata(), actorKey: "a".repeat(201) }, { ...metadata(), inputResetKey: "r".repeat(201) });
    const label = metadata(); label.chunks[0]!.printedLabel = "p".repeat(121); cases.push(label);
    const hole = metadata(); hole.chunks = new Array(1); cases.push(hole);
    for (const key of ["extra", "01", "1000", Symbol("private")]) {
      const extra = metadata(); Object.defineProperty(extra.chunks, key, { value: "PRIVATE_EXTRA_CANARY", enumerable: true }); cases.push(extra);
    }
    const hidden = metadata(); Object.defineProperty(hidden, "actorKey", { value: "hidden", enumerable: false }); cases.push(hidden);
    const symbol = metadata(); Object.defineProperty(symbol.chunks[0]!, Symbol("private"), { value: "secret" }); cases.push(symbol);
    const cycle = metadata(); Object.defineProperty(cycle.chunks[0]!, "printedLabel", { value: cycle, enumerable: true }); cases.push(cycle);
    for (const value of cases) expect(mappingDraftMetadataSchema.safeParse(value).success).toBe(false);
  });
  it("rejects accessors on chunk indices, extra array properties and hidden metadata without calling them", () => {
    for (const target of ["index", "array-extra", "hidden-root", "hidden-chunk"]) {
      const input = metadata(); let reads = 0;
      const object = target === "hidden-root" ? input : target === "hidden-chunk" ? input.chunks[0]! : input.chunks;
      const key = target === "index" ? "0" : target === "hidden-root" ? "actorKey" : target === "hidden-chunk" ? "printedLabel" : "extra";
      Object.defineProperty(object, key, { enumerable: !target.startsWith("hidden"), get() { reads++; throw new Error("PRIVATE_EXTRA_GETTER_CANARY"); } });
      expect(mappingDraftMetadataSchema.safeParse(input).success).toBe(false); expect(reads).toBe(0);
    }
  });
});

describe("pure local mapping model", () => {
  it("uses the public R2 contract; normalizes only at its boundary without mutating owner metadata or local text", () => {
    const input = metadata(), form = fields(), before = JSON.stringify([input, form]);
    const draft = buildMappingDraft(input, form)!;
    expect(materialImportBindingInputSchema.safeParse(draft).success).toBe(true);
    expect(draft.sourceSha256).toBe("a".repeat(64)); expect(draft.question.locator.sourceSha256).toBe("a".repeat(64));
    expect(draft.question.content.stem).toBe("question\n"); expect(draft.answer.content.text).toBe("answer\n");
    expect(JSON.stringify([input, form])).toBe(before);
  });
  it("requires confirmation and rejects initially empty fields", () => {
    expect(buildMappingDraft(metadata(), emptyMappingDraftFields())).toBeNull();
    expect(buildMappingDraft(metadata(), { ...fields(), confirmed: false })).toBeNull();
  });
  it.each([{ stem: "x".repeat(8001) }, { answer: "x".repeat(8001) }, { unit: "x".repeat(41) },
    { questionChunk: id(99) }, { answerChunk: id(99) }, { answerEnd: "101" }, { questionEnd: "10 " },
    { kind: "choice" as const, options: [{ id: "A", label: "x" }] },
    { kind: "choice" as const, options: [{ id: "A", label: "x" }, { id: "A", label: "y" }] },
  ])("rejects incomplete/invalid full schema or locators %j", patch => {
    expect(buildMappingDraft(metadata(), { ...fields(), ...patch })).toBeNull();
  });
  it("never invents a physical page from a printed label", () => {
    const input = metadata(); input.chunks[0]!.printedLabel = "page 150";
    const draft = buildMappingDraft(input, fields())!;
    expect(draft.question.locator.physicalPage).toBeNull(); expect(draft.question.locator.printedLabel).toBe("page 150");
  });
  it.each([{ sourceSha256: "bad" }, { sourceVersion: -1 }, { expectedManifestRevision: -1 }, { questionContentVersion: -1 },
    { actorKey: "" }, { inputResetKey: "" }, { chunks: [] }, { sourceId: "unknown" },
  ])("closes invalid metadata without supplying defaults %j", patch => {
    expect(mappingDraftMetadataSchema.safeParse({ ...metadata(), ...patch }).success).toBe(false);
  });
});
