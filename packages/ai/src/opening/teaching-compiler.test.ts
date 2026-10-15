import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { ALLOWED_TEACHING_BLOCK_TYPES, type TeachingOutline } from "@aistudy/domain";
import { assembleTeachingEvidencePack } from "./teaching-evidence";
import {
  buildCompileProviderInput,
  compileCurrentActivity,
  createCompilerBuildPublishInput,
  parseCompileModelOutput,
  TeachingCompileOutputError,
  projectClientSafeLibraryBlocks,
  proposeTeachingOutline,
  createCompilerProviderInput,
  continuationNote,
  nextMaterialWindow,
  verifiedQuote,
} from "./teaching-compiler";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "../../../../tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json",
);

const ACTIVITY = "00000000-0000-4000-8000-0000000000a1";
const UNIT = "00000000-0000-4000-8000-0000000000u1";
const SRC_A = "00000000-0000-4000-8000-0000000000aa";
const SRC_B = "00000000-0000-4000-8000-0000000000bb";
const SRC_HELD = "00000000-0000-4000-8000-0000000000dd";

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  activities: Array<{
    activityId: string;
    titleZh: string;
    goalIds: string[];
    blockTypes: string[];
    sourceIds: string[];
    notesZh?: string;
    order: number;
  }>;
};

/** Map fixture SRC-* ids onto stable UUIDs for publish graph. */
const FIXTURE_SOURCE_MAP: Record<string, string> = {
  "SRC-RN-01": SRC_A,
  "SRC-RN-02": SRC_B,
  "SRC-RN-03": SRC_A,
  "SRC-RN-04": SRC_B,
  "SRC-RN-05": SRC_A,
};

function mapFixtureOutline(focusIndex = 0): TeachingOutline {
  const items = fixture.activities.map((a, i) => ({
    itemId: a.activityId,
    title: a.titleZh,
    goalIds: a.goalIds,
    intendedBlockTypes: a.blockTypes,
    sourceIds: a.sourceIds.map((id) => FIXTURE_SOURCE_MAP[id] ?? SRC_A),
    notes: a.notesZh,
    prereqItemIds: i > 0 ? [fixture.activities[i - 1]!.activityId] : undefined,
  }));
  return {
    outlineId: "fixture-rank-nullspace",
    activityId: ACTIVITY,
    teachingUnitId: UNIT,
    focusItemId: items[focusIndex]!.itemId,
    items,
    prereqs: [],
    kind: "teaching_path",
  };
}

const chunk = (
  id: string,
  text: string,
  opts: Partial<SourceChunk> & { sourceId?: string; page?: number | null } = {},
): SourceChunk => ({
  id,
  sourceId: opts.sourceId ?? SRC_A,
  sourceVersion: opts.sourceVersion ?? 1,
  page: opts.page === undefined ? 1 : opts.page,
  slideLabel: opts.slideLabel ?? null,
  startMs: opts.startMs ?? null,
  endMs: opts.endMs ?? null,
  text,
  imageObjectKey: opts.imageObjectKey ?? null,
});

let blockSeq = 0;
function stableBlockId(): string {
  blockSeq += 1;
  return `00000000-0000-4000-8000-${String(blockSeq).padStart(12, "0")}`;
}

describe("teaching-compiler", () => {
  it("C1: edited outline is used for compile — no silent overwrite", () => {
    const base = proposeTeachingOutline({
      activityId: ACTIVITY,
      intentSummary: "rank and nullspace",
      intentKind: "material",
      sourceIds: [SRC_A],
      chunks: [chunk("c1", "nullspace basis")],
      maxItems: 3,
    });
    const edited: TeachingOutline = {
      ...base,
      items: base.items.map((item, i) =>
        i === 0
          ? { ...item, title: "EDITED HOOK TITLE", notes: "user edit wins" }
          : item,
      ),
    };
    const reused = proposeTeachingOutline({
      activityId: ACTIVITY,
      intentSummary: "model would want a different title",
      intentKind: "material",
      sourceIds: [SRC_A],
      chunks: [chunk("c1", "nullspace basis")],
      existingOutline: edited,
    });
    expect(reused.items[0]!.title).toBe("EDITED HOOK TITLE");
    expect(reused.items[0]!.notes).toBe("user edit wins");

    const pack = assembleTeachingEvidencePack({
      chunks: [chunk("c1", "nullspace of A")],
      query: "nullspace",
      maxCharacters: 2000,
      allowlistSourceIds: [SRC_A],
    });
    blockSeq = 0;
    const compiled = compileCurrentActivity({
      outline: reused,
      focusItemId: reused.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      newBlockId: stableBlockId,
    });
    expect(compiled.outlineUsed.items[0]!.title).toBe("EDITED HOOK TITLE");
    expect(JSON.stringify(compiled.publishInput.goals)).toContain("EDITED HOOK TITLE");
  });

  it("C2: compiles current focus only; prefetch ≤1 skeleton", () => {
    const outline = mapFixtureOutline(0);
    const pack = assembleTeachingEvidencePack({
      chunks: [chunk("c1", "T(x,y)=(x+y,0) maps R2")],
      query: outline.items[0]!.title,
      maxCharacters: 2000,
    });
    blockSeq = 0;
    const compiled = compileCurrentActivity({
      outline,
      focusItemId: outline.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      prefetchNext: true,
      newBlockId: stableBlockId,
    });
    expect(compiled.publishInput.blockOrder.length).toBeGreaterThan(0);
    expect(compiled.prefetchSkeleton?.itemId).toBe(outline.items[1]!.itemId);
    // Only one skeleton — not whole-course bodies
    expect(compiled.libraryBlocks.every((b) => typeof b.id === "string")).toBe(true);
    const withoutPrefetch = compileCurrentActivity({
      outline,
      focusItemId: outline.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      prefetchNext: false,
      newBlockId: stableBlockId,
    });
    expect(withoutPrefetch.prefetchSkeleton ?? null).toBeNull();
  });

  it("C6: no current page still builds pack + presentable blocks", () => {
    const outline = proposeTeachingOutline({
      activityId: ACTIVITY,
      intentSummary: "nullspace without page",
      intentKind: "material",
      sourceIds: [SRC_A],
      chunks: [chunk("c1", "rank-nullity theorem", { page: null })],
      currentPage: null,
      maxItems: 2,
    });
    const pack = assembleTeachingEvidencePack({
      chunks: [chunk("c1", "rank-nullity theorem", { page: null })],
      query: "rank",
      maxCharacters: 2000,
      // preferPage omitted — no current page
    });
    blockSeq = 0;
    const compiled = compileCurrentActivity({
      outline,
      focusItemId: outline.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      newBlockId: stableBlockId,
    });
    expect(compiled.publishInput.blockOrder.length).toBeGreaterThan(0);
    expect(compiled.publishInput.generationConfig?.extras).not.toHaveProperty("stub");
  });

  it("C7: distinct outline notes for intent variants without mastery lock", () => {
    const variants: Array<{ kind: string; summary: string; expectNote: RegExp }> = [
      { kind: "topic", summary: "topic-only: linear maps", expectNote: /主题学习/ },
      { kind: "material", summary: "already know → skimming please", expectNote: /速览/ },
      { kind: "goal", summary: "无基础 learner needs foundations", expectNote: /零基础/ },
      { kind: "question", summary: "conflict goals between depth and speed", expectNote: /目标冲突/ },
      { kind: "material", summary: "intent-only material path", expectNote: /材料|学习意图/ },
    ];
    for (const v of variants) {
      const outline = proposeTeachingOutline({
        activityId: ACTIVITY,
        intentSummary: v.summary,
        intentKind: v.kind,
        sourceIds: [SRC_A],
        chunks: [],
        maxItems: 3,
      });
      const note = outline.items[0]?.notes ?? "";
      expect(note).toMatch(v.expectNote);
      expect(JSON.stringify(outline)).not.toMatch(/masteryPercent|mastery_pct|"mastery"/);
    }
  });

  it("C8: allowlist clamps fixture matrix-viz", () => {
    const outline = mapFixtureOutline(0);
    const normalized = proposeTeachingOutline({
      activityId: ACTIVITY,
      intentSummary: "x",
      intentKind: "material",
      sourceIds: [SRC_A],
      chunks: [],
      existingOutline: outline,
    });
    for (const item of normalized.items) {
      expect(item.intendedBlockTypes).not.toContain("matrix-viz");
      for (const t of item.intendedBlockTypes) {
        expect(ALLOWED_TEACHING_BLOCK_TYPES).toContain(t);
      }
    }
  });

  it("C9: held-out / privacy — no forged sourceRefs outside pack", () => {
    const outline = mapFixtureOutline(0);
    const pack = assembleTeachingEvidencePack({
      chunks: [
        chunk("c-ok", "authorized lecture text", { sourceId: SRC_A }),
        chunk("c-held", "SECRET HELD OUT", { sourceId: SRC_HELD }),
      ],
      query: "lecture",
      maxCharacters: 2000,
      allowlistSourceIds: [SRC_A],
      denylist: { sourceIds: [SRC_HELD] },
      privacyExcludedSourceIds: [SRC_HELD],
    });
    expect(pack.chunks.every((c) => c.sourceId !== SRC_HELD)).toBe(true);
    blockSeq = 0;
    const compiled = compileCurrentActivity({
      outline,
      focusItemId: outline.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      newBlockId: stableBlockId,
    });
    for (const ref of compiled.publishInput.sourceRefs ?? []) {
      expect(ref.sourceId).not.toBe(SRC_HELD);
    }
    expect(JSON.stringify(compiled.publishInput)).not.toContain("SECRET HELD OUT");
  });

  it("answer_key never leaks in client-facing projection", () => {
    const outline = proposeTeachingOutline({
      activityId: ACTIVITY,
      intentSummary: "with answer key",
      intentKind: "material",
      sourceIds: [SRC_A],
      chunks: [chunk("c1", "solution steps")],
      maxItems: 1,
    });
    outline.items[0]!.intendedBlockTypes = ["text", "answer_key", "prompt"];
    const pack = assembleTeachingEvidencePack({
      chunks: [chunk("c1", "solution steps")],
      query: "solution",
      maxCharacters: 1000,
    });
    blockSeq = 0;
    const compiled = compileCurrentActivity({
      outline,
      focusItemId: outline.focusItemId,
      pack,
      teachingUnitId: UNIT,
      expectedContentVersion: 0,
      revisionNumber: 1,
      newBlockId: stableBlockId,
    });
    const keyBlock = compiled.libraryBlocks.find((b) => b.role === "answer_key");
    expect(keyBlock).toBeTruthy();
    expect(keyBlock!.content.answer).toBeTruthy();
    const client = projectClientSafeLibraryBlocks(compiled.libraryBlocks);
    const clientKey = client.find((b) => b.role === "answer_key");
    expect(clientKey?.content).toBeNull();
    // publish graph carries refs only — no answer plaintext field on publishInput
    expect(JSON.stringify(compiled.publishInput)).not.toContain('"answer":');
  });

  it("buildCompileProviderInput reuses UNTRUSTED delimiters via formatProviderContext", () => {
    const outline = mapFixtureOutline(0);
    const pack = assembleTeachingEvidencePack({
      chunks: [chunk("c1", "rank nullity")],
      query: "rank",
      maxCharacters: 1000,
    });
    const providerInput = buildCompileProviderInput(outline, pack);
    expect(providerInput.instruction).toMatch(/authorized|UNTRUSTED|outline/i);
    expect(providerInput.text).toContain("OUTLINE JSON");
    expect(providerInput.text).toMatch(/UNTRUSTED/);
  });

  it("parseCompileModelOutput keeps allowed blocks, drops unknown types and invented chunk ids", () => {
    const parsed = parseCompileModelOutput(JSON.stringify({
      itemTitles: ["秩", " 零空间 ", 3],
      blocks: [
        { type: "text", text: "rank", citedChunkIds: ["c1", "invented"] },
        { type: "html", text: "<script>" },
        { type: "answer_key", text: "3" },
      ],
    }), new Set(["c1"]));
    expect(parsed.itemTitles).toEqual(["秩", "零空间"]);
    expect(parsed.blocks).toEqual([
      { type: "text", text: "rank", citedChunkIds: ["c1"] },
      { type: "answer_key", text: "3", citedChunkIds: [] },
    ]);
    expect(() => parseCompileModelOutput("not json", new Set())).toThrow(TeachingCompileOutputError);
    expect(() => parseCompileModelOutput(JSON.stringify({ blocks: [{ type: "prompt", text: "q?" }] }), new Set())).toThrow(/no teaching block/);
  });

  it("a continued section teaches the next outline item and tells the model what was covered", async () => {
    const payload = { activityId: ACTIVITY, teachingUnitId: UNIT, expectedContentVersion: 0, sourceIds: [SRC_A] };
    const options = { loadChunks: async () => [chunk("c1", "零空间材料")], intentSummary: "零空间", intentKind: "goal" };
    const first = await createCompilerProviderInput(options)({}, payload);
    expect(first.text).toContain("focusItemId=item-01");
    expect(first.text).not.toContain("第 2 节");
    const second = await createCompilerProviderInput({ ...options, priorSectionTitles: ["零空间是什么"] })({}, payload);
    expect(second.text).toContain("focusItemId=item-02");
    expect(second.text).toContain("第1节：零空间是什么");
    expect(continuationNote([])).toBe("");

    const build = createCompilerBuildPublishInput({ ...options, priorSectionTitles: ["零空间是什么"], newBlockId: stableBlockId, writeLibraryBlocks: async () => {} });
    blockSeq = 0;
    const published = await build({}, payload, { text: JSON.stringify({ itemTitles: ["引入", "零空间的维数"], blocks: [{ type: "text", text: "维数等于 n − rank。" }] }) });
    expect(published.generationConfig?.extras).toMatchObject({ focusItemId: "item-02" });
    expect(published.goals?.[0]?.statement).toBe("零空间的维数");
  });

  // Real example: English Math I slides (Unit 8), one chunk per page, taught in Chinese.
  const unit8 = [
    [3, "Jacobian Let f : U ⊂ Rn → Rn be defined on an open set U. The determinant of the differential matrix of f at u is called the Jacobian of f at u, and is denoted by Jf (u)."],
    [4, "Inverse Function Theorem Let f be of class C 1 on U, and satisfy Jf (u) ̸= 0 for some u ∈ U. Then there exist open sets V ⊂ U and W ⊂ f (U)."],
    [10, "Local Extrema Fermat's Theorem If the function attains a relative extremum at an interior point x0 of U and the partial derivatives exist, then ∇f (x0 ) = 0."],
    [16, "Criterion for the Two-Variable Case If ∆ > 0 and D11 f (a, b) > 0, then f (a, b) is a relative minimum. If ∆ < 0, then f presents a saddle point."],
    [19, "Lagrange Multipliers Suppose that {∇Φ1 (u), . . . , ∇Φk (u)} are linearly independent vectors for all u ∈ U."],
  ].map(([page, text]) => chunk(`p${page}`, String(text).padEnd(900, " "), { page: Number(page) }));

  it("a material walk teaches the slides in order, one stretch per section, then reviews", () => {
    const first = nextMaterialWindow([...unit8].reverse(), [SRC_A], [], 2400);
    expect(first.chunks.map((c) => c.id)).toEqual(["p3", "p4"]);
    expect(first.review).toBe(false);
    const second = nextMaterialWindow(unit8, [SRC_A], ["p3", "p4"], 2400);
    expect(second.chunks.map((c) => c.id)).toEqual(["p10", "p16"]);
    const third = nextMaterialWindow(unit8, [SRC_A], ["p3", "p4", "p10", "p16"], 2400);
    expect(third.chunks.map((c) => c.id)).toEqual(["p19"]);
    const review = nextMaterialWindow(unit8, [SRC_A], unit8.map((c) => c.id), 2400);
    expect(review).toMatchObject({ review: true });
    expect(review.chunks[0]!.id).toBe("p3");
  });

  it("keeps a quote only when it occurs verbatim in a cited chunk (spacing and case ignored)", () => {
    const texts = new Map(unit8.map((c) => [c.id, c.text]));
    const quote = "the determinant of the differential matrix of f at u is called the Jacobian";
    expect(verifiedQuote(quote, ["p3"], texts)).toBe(quote);
    expect(verifiedQuote("If ∆ > 0 and D11 f(a,b) > 0", ["p16"], texts)).toBeTruthy();
    expect(verifiedQuote(quote, ["p16"], texts)).toBeUndefined();
    expect(verifiedQuote("Jacobian 是行列式", ["p3"], texts)).toBeUndefined();
    expect(verifiedQuote("Jf", ["p3"], texts)).toBeUndefined();
  });

  it("a Chinese lesson on English slides publishes the walk window and the checked quote", async () => {
    const build = createCompilerBuildPublishInput({
      loadChunks: async () => unit8, intentSummary: "Math I · 第8单元", intentKind: "goal", newBlockId: stableBlockId,
      requireModelOutput: true, materialWalk: { priorChunkIds: ["p3", "p4"], sectionCharacters: 2400 },
      writeLibraryBlocks: async (blocks) => { written = blocks; },
    });
    let written: Array<{ type: string; content: Record<string, unknown> }> = [];
    blockSeq = 0;
    const published = await build({}, { activityId: ACTIVITY, teachingUnitId: UNIT, expectedContentVersion: 0, sourceIds: [SRC_A] }, { text: JSON.stringify({ itemTitles: [], blocks: [
      { type: "text", text: "费马定理（Fermat's Theorem）：内点取得极值且偏导存在时，梯度为零。", citedChunkIds: ["p10"], quote: "then ∇f (x0 ) = 0" },
      { type: "text", text: "鞍点（saddle point）判别。", citedChunkIds: ["p16"], quote: "this sentence is not on the slide" },
    ] }) });
    expect(published.sourceRefs?.map((ref) => ref.chunkId)).toEqual(["p10", "p16"]);
    expect(written[0]!.content.sourceQuote).toBe("then ∇f (x0 ) = 0");
    expect(written[1]!.content).not.toHaveProperty("sourceQuote");
  });

  it("places each answer_key right after its question so the learner can see the reference", () => {
    const parsed = parseCompileModelOutput(JSON.stringify({ itemTitles: [], blocks: [
      { type: "text", text: "讲解" },
      { type: "prompt", text: "第一题" },
      { type: "example", text: "例子" },
      { type: "prompt", text: "第二题" },
      { type: "answer_key", text: "答案一" },
      { type: "answer_key", text: "答案二" },
    ] }), new Set());
    expect(parsed.blocks.map((b) => b.text)).toEqual(["讲解", "第一题", "答案一", "例子", "第二题", "答案二"]);
  });

  it("model output replaces template blocks, keeps answer_key hidden and applies learner-facing titles", async () => {
    const build = createCompilerBuildPublishInput({
      loadChunks: async () => [chunk("c1", "authorized material on nullspace")],
      intentSummary: "零空间",
      intentKind: "material",
      newBlockId: stableBlockId,
      requireModelOutput: true,
      writeLibraryBlocks: async (blocks) => { written = blocks; },
    });
    let written: Array<{ type: string; role: string; content: Record<string, unknown> }> = [];
    blockSeq = 0;
    const titles = ["零空间是什么", "观察", "定义", "例子", "检查", "练习"];
    const publishInput = await build({}, { activityId: ACTIVITY, teachingUnitId: UNIT, expectedContentVersion: 0, sourceIds: [SRC_A] }, {
      text: JSON.stringify({ itemTitles: titles, blocks: [
        { type: "text", text: "零空间是 $Ax=0$ 的解集。", citedChunkIds: ["c1"] },
        { type: "steps", text: "1. 写出方程\n2. 化简" },
        { type: "prompt", text: "求零空间维数？" },
        { type: "answer_key", text: "n − rank" },
      ] }),
    });
    expect(written.map((b) => b.type)).toEqual(["text", "steps", "prompt", "answer_key"]);
    expect(written[1]!.content).toEqual({ steps: ["写出方程", "化简"] });
    expect(written[3]).toMatchObject({ role: "answer_key", content: { answer: "n − rank", hidden: true } });
    expect(publishInput.generationConfig?.extras).toMatchObject({ contentSource: "model" });
    expect(publishInput.goals?.map((g) => g.statement).join(" ")).not.toMatch(/Hook:|引入：|path:/);
    await expect(build({}, { activityId: ACTIVITY, teachingUnitId: UNIT, expectedContentVersion: 0, sourceIds: [SRC_A] }, { text: "{}" }))
      .rejects.toBeInstanceOf(TeachingCompileOutputError);
  });

  it("C10 helper: createCompilerBuildPublishInput yields non-empty blockOrder without stub", async () => {
    const build = createCompilerBuildPublishInput({
      loadChunks: async (_scope, _ids) => [chunk("c1", "authorized material on nullspace")],
      intentSummary: "compile current activity",
      intentKind: "material",
      newBlockId: stableBlockId,
    });
    blockSeq = 0;
    const publishInput = await build(
      {},
      {
        activityId: ACTIVITY,
        teachingUnitId: UNIT,
        expectedContentVersion: 0,
        sourceIds: [SRC_A],
      },
      { text: "{}" },
    );
    expect(publishInput.blockOrder.length).toBeGreaterThan(0);
    expect(publishInput.generationConfig?.extras).not.toHaveProperty("stub");
    expect(publishInput.verificationStatus).toBe("needs_check");
  });
});
