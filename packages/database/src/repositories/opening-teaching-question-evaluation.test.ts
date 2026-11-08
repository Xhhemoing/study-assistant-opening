import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { evaluateOpeningTeachingKeyAttempt, readOpeningTeachingBlindSolveKeyMetadata } from "./opening-teaching-question-evaluation";
import { teachingQuestionBody, teachingQuestionText } from "./opening-teaching-question";

const exposure = vi.hoisted(() => ({ reveal: vi.fn(), insert: vi.fn(), generate: vi.fn(), release: vi.fn() }));
vi.mock("./opening-teaching-hints", () => ({ readOpeningTeachingAnswerKey: exposure.reveal }));
vi.mock("./opening-learning-help", () => ({ insertOpeningDeliveredHelp: exposure.insert }));
vi.mock("./opening-study-exposure", () => ({
  generateOpeningStudyExposure: exposure.generate, releaseOpeningStudyExposure: exposure.release,
}));

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const attempt = { id: "attempt", course_id: "course", problem_id: "problem", item_version_id: "item", create_intent: { teachingBlock: {} } };
const spec = { kind: "teaching_question", specVersion: "teaching-question-v1", blockId: "q", answerBlockId: "a", revisionId: "r" };
const numeric = { kind: "numeric" };
const choice = { kind: "choice", options: [{ id: "A", label: "1" }, { id: "B", label: "2" }] };
const block = (content: unknown, type = "prompt", id = "q") => ({ id, type, content });
const key = (answer: string) => block({ answer }, "answer_key", "a");
/** Watch content, not id: looking up the prompt may visit the key's id in any fixture order. */
function watchedKey(answer: string) {
  const read = vi.fn(() => ({ answer }));
  return { read, block: { id: "a", type: "answer_key", get content() { return read(); } } };
}
const numericBlocks = [block({ text: "1+1", interaction: numeric }), key("2")];

type FixtureOptions = { evaluationSpec?: unknown; blocks?: unknown; missingRow?: boolean; priorFeedback?: boolean };
function setup(options: FixtureOptions = {}) {
  const tx = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = parts.join("?");
    if (sql.includes("SELECT v.evaluation_spec,r.blocks")) return Promise.resolve(options.missingRow ? [] : [{
      evaluation_spec: "evaluationSpec" in options ? options.evaluationSpec : spec,
      blocks: "blocks" in options ? options.blocks : numericBlocks,
    }]);
    if (sql.includes("SELECT o.id")) return Promise.resolve(options.priorFeedback ? [{ id: "previous" }] : []);
    if (sql.startsWith("(v.teaching_revision_id IS NULL")) return "identity predicate";
    throw new Error(`Unexpected SQL during grading: ${sql}`);
  });
  const evaluate = (answer: string, input: Record<string, unknown> | undefined) =>
    evaluateOpeningTeachingKeyAttempt(tx as unknown as TransactionSql, scope, input, answer, []);
  return { tx, evaluate, run: (answer: string) => evaluate(answer, attempt) };
}

afterEach(() => {
  for (const fn of Object.values(exposure)) expect(fn).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

describe("private blind-solve key metadata", () => {
  it("requires a matched receipt bound to the current revision/source/item identity and reads only", async () => {
    const identity = { activityId: "11111111-1111-4111-8111-111111111111", teachingRevisionId: "22222222-2222-4222-8222-222222222222",
      blockId: "33333333-3333-4333-8333-333333333333", contentVersion: 1, sourceVersions: {},
      generatorModelIdentity: { providerId: "g", modelName: "g", family: "a" } };
    const receipt = { protocol: "teaching-blind-solve-1", identity, operationId: "solve:job:block",
      modelSnapshot: { id: "s", providerId: "s", modelName: "s", inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
      family: "b", decision: "match", solverAnswer: "4", reasonCodes: ["pinned_key_match"], costLedgerRef: "ledger" };
    const query = vi.fn(async (..._args: unknown[]): Promise<Array<{ receipt: unknown }>> => [{ receipt }]);
    const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as TransactionSql;
    expect(await readOpeningTeachingBlindSolveKeyMetadata(tx, scope, identity)).toMatchObject({ eligibility: "matched_current", receipt });
    expect(await readOpeningTeachingBlindSolveKeyMetadata(tx, scope, { ...identity, contentVersion: 2 })).toEqual({ eligibility: "unknown", receipt: null });
    expect(await readOpeningTeachingBlindSolveKeyMetadata(tx, scope, { ...identity, itemVersionId: identity.blockId })).toEqual({ eligibility: "unknown", receipt: null });
    query.mockResolvedValue([{ receipt: undefined }]);
    expect(await readOpeningTeachingBlindSolveKeyMetadata(tx, scope, identity)).toEqual({ eligibility: "unknown", receipt: null });
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

describe("teaching key evaluation", () => {
  it.each([
    ["correct", "2", false], ["correct", "2", true],
    ["incorrect", "3", false], ["incorrect", "3", true],
  ] as const)("returns the complete %s result for answer %s with priorFeedback=%s", async (decision, answer, priorFeedback) => {
    const f = setup({ priorFeedback });
    expect(await f.run(answer)).toEqual({
      evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1",
      decision, outcome: decision,
      reasonCodes: [decision === "correct" ? "teaching_key_match" : "teaching_key_mismatch"], priorFeedback,
    });
    const priorQuery = f.tx.mock.calls.find(([parts]) => parts.join(" ").includes("SELECT o.id"));
    expect(priorQuery?.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId, attempt.course_id, spec.revisionId, spec.blockId, attempt.id]);
  });

  it.each([["B. 2", "correct"], ["A. 1", "incorrect"]] as const)(
    "evaluates choice %s from prompt body without option lines", async (answer, decision) => {
      const f = setup({ blocks: [block({ text: "1+1", interaction: choice }), key("B")] });
      expect(await f.run(answer)).toEqual({
        evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1",
        decision, outcome: decision,
        reasonCodes: [decision === "correct" ? "teaching_key_match" : "teaching_key_mismatch"], priorFeedback: false,
      });
      expect(f.tx.mock.calls.map(([parts]) => parts.join(" ")).join(" "))
        .not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b|opening_help_exposures|opening_study_exposures/i);
    },
  );

  it("falls back before reading the answer key or prior feedback when prompt repair can collide choices", async () => {
    const answerKey = watchedKey("2");
    const interaction = { kind: "choice", options: [
      { id: "B. \\times", label: "2" }, { id: "B", label: "\times. 2" },
    ] };
    const f = setup({ blocks: [block({ text: "1+1", interaction }), answerKey.block] });
    expect(await f.run("B. \\times. 2")).toBeNull();
    expect(answerKey.read).not.toHaveBeenCalled();
    expect(f.tx.mock.calls.some(([parts]) => parts.join(" ").includes("SELECT o.id"))).toBe(false);
  });

  it("still evaluates the same choice when prompt content needs no repair", async () => {
    const interaction = { kind: "choice", options: [
      { id: "B. \\times", label: "2" }, { id: "B", label: "3" },
    ] };
    const f = setup({ blocks: [block({ text: "1+1", interaction }), key("2")] });
    expect(await f.run("B. \\times. 2")).toMatchObject({ decision: "correct" });
  });

  const twoChoices = { kind: "choice", options: [{ id: "A", label: "2" }, { id: "B", label: "3" }] };
  it.each([
    ["question and latex without text", { question: "1+1", latex: "1+2" }],
    ["prompt without text", { prompt: "1+1" }],
    ["empty text before markdown", { text: "", markdown: "1+1" }],
  ] satisfies Array<[string, Record<string, unknown>]>)("falls back before reading the answer key for %s", async (_name, content) => {
    const answerKey = watchedKey("2");
    const f = setup({ blocks: [block({ ...content, interaction: twoChoices }), answerKey.block] });
    expect(await f.run("A. 2")).toBeNull();
    expect(answerKey.read).not.toHaveBeenCalled();
    expect(f.tx.mock.calls.some(([parts]) => parts.join(" ").includes("SELECT o.id"))).toBe(false);
  });

  it("evaluates the text stem even when another stem field disagrees", async () => {
    const f = setup({ blocks: [block({ text: "1+1", question: "9+9", interaction: twoChoices }), key("2")] });
    expect(await f.run("A. 2")).toMatchObject({ decision: "correct" });
  });
  it.each([
    ["missing attempt", undefined],
    ["missing item version", { ...attempt, item_version_id: null }],
    ["missing create intent", { ...attempt, create_intent: null }],
    ["missing teaching block", { ...attempt, create_intent: {} }],
  ] as const)("returns null before reading when %s", async (_name, input) => {
    const f = setup();
    expect(await f.evaluate("2", input)).toBeNull();
    expect(f.tx).not.toHaveBeenCalled();
  });

  it.each([
    ["missing pinned row", { missingRow: true }],
    ["invalid blocks", { blocks: {} }],
    ["null blocks", { blocks: null }],
    ["missing spec", { evaluationSpec: null }],
    ["other spec kind", { evaluationSpec: { ...spec, kind: "matrix" } }],
    ["other spec version", { evaluationSpec: { ...spec, specVersion: "future" } }],
    ["missing paired key id", { evaluationSpec: { ...spec, answerBlockId: null } }],
    ["missing prompt", { blocks: [key("2")] }],
    ["wrong prompt id", { blocks: [block({ text: "1+1", interaction: numeric }, "prompt", "other"), key("2")] }],
    ["wrong prompt type", { blocks: [block({ text: "1+1", interaction: numeric }, "paragraph"), key("2")] }],
    ["empty prompt body", { blocks: [block({ text: " ", interaction: numeric }), key("2")] }],
    ["missing interaction", { blocks: [block({ text: "1+1" }), key("2")] }],
    ["invalid interaction", { blocks: [block({ text: "1+1", interaction: { kind: "choice", options: [] } }), key("2")] }],
    ["missing paired key", { blocks: [numericBlocks[0]] }],
    ["wrong key id", { blocks: [numericBlocks[0], block({ answer: "2" }, "answer_key", "other")] }],
    ["wrong key type", { blocks: [numericBlocks[0], block({ answer: "2" }, "paragraph", "a")] }],
    ["empty key", { blocks: [numericBlocks[0], key(" ")] }],
    ["absent key text", { blocks: [numericBlocks[0], block({}, "answer_key", "a")] }],
    ["uncomputable question", { blocks: [block({ text: "Explain addition", interaction: numeric }), key("2")] }],
    ["single-number question", { blocks: [block({ text: "2", interaction: numeric }), key("2")] }],
    ["numeric unit", { blocks: [block({ text: "1+1", interaction: { kind: "numeric", unit: "m" } }), key("2")] }],
    ["incorrect numeric key", { blocks: [numericBlocks[0], key("3")] }],
    ["uncheckable numeric key", { blocks: [numericBlocks[0], key("unknown")] }],
    ["choice key points elsewhere", { blocks: [block({ text: "1+1", interaction: choice }), key("A")] }],
    ["incorrect value choice key", { blocks: [block({ text: "1+1", interaction: choice }), key("3")] }],
    ["uncheckable choice key", { blocks: [block({ text: "1+1", interaction: choice }), key("选 B")] }],
    ["zero matching options", { blocks: [block({ text: "3+3", interaction: choice }), key("B")] }],
    ["multiple matching options", { blocks: [block({ text: "1+1", interaction: { kind: "choice", options: [{ id: "A", label: "2" }, { id: "B", label: "2.0" }] } }), key("B")] }],
  ] satisfies Array<[string, FixtureOptions]>)("returns null for %s", async (_name, options) => {
    const f = setup(options);
    expect(await f.run("2")).toBeNull();
    expect(f.tx.mock.calls.some(([parts]) => parts.join(" ").includes("SELECT o.id"))).toBe(false);
  });

  it.each(["1+1", "2 m", "π", "2 2", ""])("returns null for unparseable numeric answer %j", async answer => {
    expect(await setup().run(answer)).toBeNull();
  });
  it("returns null for a decimal approximation to a repeating value", async () => {
    const f = setup({ blocks: [block({ text: "1/6+1/6", interaction: numeric }), key("1/3")] });
    expect(await f.run("0.333")).toBeNull();
  });
  it.each(["C. 2", "B", "B.2"])("returns null for unparseable choice answer %j", async answer => {
    const f = setup({ blocks: [block({ text: "1+1", interaction: choice }), key("B")] });
    expect(await f.run(answer)).toBeNull();
  });
  it("accepts question and solution blocks from the pinned revision", async () => {
    const f = setup({ blocks: [block({ text: "1+1", interaction: numeric }, "question"), block({ solution: "2" }, "solution", "a")] });
    expect(await f.run("2")).toMatchObject({ decision: "correct" });
  });
});

describe("teaching question text", () => {
  it.each(["text", "markdown", "prompt", "question", "answer", "solution"])("extracts %s as body", field => {
    expect(teachingQuestionBody({ [field]: " 1+1 " })).toBe(" 1+1 ");
  });
  it("selects the first nonempty string and preserves its whitespace", () => {
    expect(teachingQuestionBody({ text: " ", markdown: 4, prompt: " 1+1 ", question: "ignored" })).toBe(" 1+1 ");
    expect(teachingQuestionBody({ text: "first", markdown: "second" })).toBe("first");
    expect(teachingQuestionBody({ text: " ", answer: null })).toBeNull();
    expect(teachingQuestionBody(undefined)).toBeNull();
  });
  it("preserves complete choice, numeric-unit and plain text verbatim", () => {
    const cases = [
      [{ text: "1+1", interaction: choice }, "1+1\nA. 1\nB. 2"],
      [{ markdown: "1+1", interaction: { kind: "numeric", unit: "m" } }, "1+1\n单位：m"],
      [{ text: " ", prompt: "1+1" }, "1+1"],
    ] as const;
    for (const [content, text] of cases) {
      expect(teachingQuestionBody(content)).toBe("1+1");
      expect(teachingQuestionText(content)).toBe(text);
    }
  });
});
