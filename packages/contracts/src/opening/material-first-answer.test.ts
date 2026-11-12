import { describe, expect, it } from "vitest";
import { projectMaterialFirstAnswer, type MaterialFirstAnswerInput } from "./material-first-answer";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const canary = "PRIVATE_CANARY_答案_solution_974fe";
const invalid = { ok: false, code: "INVALID_FIRST_ANSWER" };
function fixture(): MaterialFirstAnswerInput {
  const locator = { sourceId: id(1), sourceVersion: 2, locatorId: id(2) };
  const publication = { activityId: id(3), courseId: id(4), blockId: id(5), revisionId: id(6),
    contentVersion: 7, mappingId: id(8), bindingRevision: 9 };
  return {
    binding: { mappingId: id(8), revision: 9, sourceLocators: [{ ...locator }] },
    publication,
    issuance: { attemptId: id(10), itemVersionId: id(11), problemId: id(12), publication: { ...publication } },
    presentation: { text: "计算 2 + 3（请选择）。", interaction: { kind: "choice", options: [
      { id: "A", label: "4" }, { id: "B", label: "5" },
    ] }, sourceLocators: [{ ...locator }] },
  };
}
function rejects(input: unknown) {
  const result = projectMaterialFirstAnswer(input);
  expect(result).toEqual(invalid);
  expect(JSON.stringify(result)).not.toContain(canary);
}
const privateFields = ["answer", "solution", "feedback", "explanation", "correctOption", "correctoption", "notes",
  "grant", "probability", "provenance", "key", "rubric", "hints", "checkpoint", "reviewProps", "rawAuthorProps",
  "answerRole", "issued", "eligible", "chunkText", "sourceText", "url", "page", "sha256", "evaluationSpec"];

describe("first-answer transport projection (not issuer/auth)", () => {
  it("returns exactly public canonical identity/version and first-answer prompt controls", () => {
    const input = fixture();
    const result = projectMaterialFirstAnswer(input);
    expect(result).toEqual({ ok: true, presentation: {
      attemptId: id(10), itemVersionId: id(11), problemId: id(12), activityId: id(3), courseId: id(4),
      blockId: id(5), contentVersion: 7, prompt: input.presentation,
    } });
    expect(JSON.stringify(result)).not.toMatch(/mappingId|bindingRevision|revisionId|publication|issuance|issued|grant/);
    input.presentation.text = canary;
    if (!result.ok) throw new Error("expected presentation");
    expect(result.presentation.prompt.text).not.toContain(canary);
    expect(result.presentation.prompt.interaction).not.toBe(input.presentation.interaction);
  });

  it("supports numeric units, emoji/non-BMP Unicode, and no unnecessary source locator", () => {
    const input = fixture();
    input.presentation = { text: "求长度 📏：é 与 x²", interaction: { kind: "numeric", unit: "厘米" }, sourceLocators: [] };
    expect(projectMaterialFirstAnswer(input)).toEqual({ ok: true, presentation: {
      attemptId: id(10), itemVersionId: id(11), problemId: id(12), activityId: id(3), courseId: id(4), blockId: id(5),
      contentVersion: 7, prompt: input.presentation,
    } });
    input.presentation.interaction = { kind: "numeric" };
    expect(projectMaterialFirstAnswer(input).ok).toBe(true);
  });

  it("accepts null-prototype own records without depending on object methods", () => {
    const input = fixture();
    Object.setPrototypeOf(input, null);
    Object.setPrototypeOf(input.presentation, null);
    expect(projectMaterialFirstAnswer(input).ok).toBe(true);
  });

  it.each(privateFields)("rejects private/extra field %s at every reachable object rather than stripping", field => {
    for (let index = 0; index < 10; index++) {
      const input = fixture();
      const interaction = input.presentation.interaction;
      if (interaction.kind !== "choice") throw new Error();
      const targets: object[] = [input, input.binding, input.publication, input.issuance, input.issuance.publication,
        input.presentation, interaction, interaction.options[0]!, input.presentation.sourceLocators[0]!, input.binding.sourceLocators[0]!];
      Object.defineProperty(targets[index]!, field, { value: canary, enumerable: true });
      rejects(input);
    }
  });

  it("does not treat author-review data, client-init, booleans or absent facts as first-answer input", () => {
    for (const value of [undefined, null, true, [], { ...fixture().presentation },
      { blocks: [{ role: "prompt", content: { text: "Q", answer: canary } }] },
      { rawAuthorProps: { text: "Q", answer: canary } }]) rejects(value);
    for (const key of ["binding", "publication", "issuance", "presentation"] as const) {
      const input: Partial<MaterialFirstAnswerInput> = fixture();
      delete input[key];
      rejects(input);
    }
  });

  it.each(["activityId", "courseId", "blockId", "revisionId", "contentVersion", "mappingId", "bindingRevision"] as const)(
    "requires exact issuance publication %s", field => {
      const input = fixture();
      Object.assign(input.issuance.publication, { [field]: typeof input.publication[field] === "number" ? 99 : id(99) });
      rejects(input);
    },
  );

  it("requires exact binding revision, mapping and authorized source version/locator", () => {
    for (const change of [
      (input: MaterialFirstAnswerInput) => { input.binding.mappingId = id(99); },
      (input: MaterialFirstAnswerInput) => { input.binding.revision++; },
      (input: MaterialFirstAnswerInput) => { input.presentation.sourceLocators[0]!.sourceVersion++; },
      (input: MaterialFirstAnswerInput) => { input.presentation.sourceLocators[0]!.sourceId = id(99); },
      (input: MaterialFirstAnswerInput) => { input.presentation.sourceLocators[0]!.locatorId = id(99); },
      (input: MaterialFirstAnswerInput) => { input.binding.sourceLocators = []; },
    ]) {
      const input = fixture(); change(input); rejects(input);
    }
    for (const key of ["binding", "presentation"] as const) {
      const input = fixture();
      input[key].sourceLocators.push({ ...input[key].sourceLocators[0]! });
      rejects(input);
    }
  });

  it("rejects malformed/duplicate/oversized interactions and unsupported response types", () => {
    for (const interaction of [
      { kind: "text" }, { kind: "numeric", unit: "x".repeat(41) },
      { kind: "choice", options: [{ id: "A", label: "4" }] },
      { kind: "choice", options: [{ id: "A", label: "4" }, { id: "A", label: "5" }] },
      { kind: "choice", options: [{ id: "A", label: "4" }, { id: "B", label: "5", correct: true }] },
      { kind: "choice", options: Array.from({ length: 7 }, (_, i) => ({ id: String(i), label: "Q" })) },
      { kind: "choice", options: [{ id: "A".repeat(21), label: "4" }, { id: "B", label: "5" }] },
      { kind: "choice", options: [{ id: "A", label: "4".repeat(501) }, { id: "B", label: "5" }] },
    ]) rejects({ ...fixture(), presentation: { ...fixture().presentation, interaction } });
  });

  it("never reads getters, toJSON, inherited records or non-enumerable/symbol extras", () => {
    let reads = 0;
    for (const location of ["root", "text", "unknown", "option", "array"] as const) {
      const input = fixture();
      const options = input.presentation.interaction.kind === "choice" ? input.presentation.interaction.options : [];
      const target = location === "root" ? input : location === "option" ? options[0]!
        : location === "array" ? options : input.presentation;
      const key = location === "root" ? "binding" : location === "text" ? "text"
        : location === "option" ? "label" : location === "array" ? "0" : "answer";
      Object.defineProperty(target, key, { enumerable: true, get() { reads++; throw new Error(canary); } });
      rejects(input);
    }
    expect(reads).toBe(0);
    for (const [key, enumerable] of [["answer", false], [Symbol("private"), true], ["toJSON", true]] as const) {
      const input = fixture(); Object.defineProperty(input.presentation, key, { enumerable, value: () => canary }); rejects(input);
    }
    rejects(Object.create(fixture()));
    const input = fixture(); Object.setPrototypeOf(input.presentation, { answer: canary }); rejects(input);
    rejects(new Date());
    rejects(new Proxy({}, { ownKeys() { throw new Error(canary); } }));
  });

  it("rejects sparse/extended arrays, cycles, excessive depth and node counts without throwing", () => {
    for (const kind of ["sparse", "extra", "symbol", "getter"] as const) {
      const input = fixture(); const refs = input.presentation.sourceLocators;
      if (kind === "sparse") refs.length = 2;
      if (kind === "extra") Object.assign(refs, { answer: canary });
      if (kind === "symbol") Object.assign(refs, { [Symbol("private")]: canary });
      if (kind === "getter") Object.defineProperty(refs, "0", { get() { throw new Error(canary); } });
      rejects(input);
    }
    const cycle: Record<string, unknown> = {}; cycle.next = cycle; rejects(cycle);
    let deep: unknown = canary;
    for (let i = 0; i < 500; i++) deep = { next: deep };
    rejects(deep);
    rejects(Array.from({ length: 100000 }, () => canary));
    let wide: unknown = canary;
    for (let i = 0; i < 4; i++) wide = Array.from({ length: 8 }, () => wide);
    rejects(wide);
  });

  it("bounds strings, safe integers and locator counts with no normalization/truncation", () => {
    for (const text of ["", " \n\t", "x".repeat(8001)]) rejects({ ...fixture(), presentation: { ...fixture().presentation, text } });
    const max = fixture(); max.presentation.text = "x".repeat(8000);
    expect(projectMaterialFirstAnswer(max).ok).toBe(true);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "7"]) {
      rejects({ ...fixture(), publication: { ...fixture().publication, contentVersion: value } });
      rejects({ ...fixture(), binding: { ...fixture().binding, revision: value } });
    }
    const input = fixture(); input.binding.revision = 0; rejects(input);
    input.presentation.sourceLocators = Array.from({ length: 9 }, (_, i) => ({ sourceId: id(1), sourceVersion: 2, locatorId: id(30 + i) }));
    rejects(input);
    const total = fixture();
    total.presentation.text = "x".repeat(8000);
    Object.assign(total, { extra: "x".repeat(8000) }); rejects(total);
  });

  it.each(["e\u0301", "\ud800", "\udc00", "\u202e", "\u2066", "\u200b", "\u0000", "\u0085"])(
    "rejects malformed/noncanonical or invisible-control Unicode %j at all string-bearing positions", text => {
      const input = fixture(); input.presentation.text = `Q${text}`; rejects(input);
      const label = fixture();
      if (label.presentation.interaction.kind !== "choice") throw new Error();
      label.presentation.interaction.options[0]!.label = `Q${text}`; rejects(label);
      const unit = fixture(); unit.presentation.interaction = { kind: "numeric", unit: text }; rejects(unit);
    },
  );

  it("makes no semantic or authorization claim about a structurally valid server input", () => {
    // Human review and real server checks remain mandatory; no string scanner
    // can prove that arbitrary stem prose does not reveal an answer.
    const input = fixture(); input.presentation.text = "A human must check this stem before issuance.";
    const result = projectMaterialFirstAnswer(input);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("issued");
    expect(result).not.toHaveProperty("authorized");
    expect(result).not.toHaveProperty("eligible");
  });
});
