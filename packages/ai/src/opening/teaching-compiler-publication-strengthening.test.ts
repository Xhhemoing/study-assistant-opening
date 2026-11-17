import { describe, expect, it, vi } from "vitest";
import type { SourceChunk, TeachingLearnerFocus } from "@aistudy/contracts";
import { assertNoHeldOutLeak } from "./teaching-evidence";
import { createCompilerBuildPublishInput, createCompilerProviderInput, projectClientSafeLibraryBlocks,
  parseCompileModelOutput, TeachingCompileOutputError } from "./teaching-compiler";

const SOURCE = "00000000-0000-4000-8000-0000000000c1";
const HELD = "00000000-0000-4000-8000-0000000000c2";
const payload = { activityId: "00000000-0000-4000-8000-0000000000a1", teachingUnitId: "00000000-0000-4000-8000-0000000000b1",
  expectedContentVersion: 4, expectedUnitVersion: 3, sourceIds: [SOURCE, HELD] };
const hints = { direction: "先写向量等式", concept: "等式要求全部坐标同时相等", firstStep: "先写第一坐标对应的方程" };
const pedagogy = { hints, misconceptions: [
  { id: "different_coefficients", manifestation: "每行改用不同系数", reason: "忽略同一线性组合", correction: "所有坐标用同一组系数" },
  { id: "skip_coordinate", manifestation: "忽略第三坐标", reason: "只验证了部分约束", correction: "把系数代回全部坐标" },
], startChoice: { correct: { step: "写出所有坐标对应的方程", why: "同一组系数必须满足全部约束" },
  misconception: { step: "只选择容易的两个坐标", why: "剩余坐标可能矛盾", misconceptionId: "skip_coordinate" } } };
const q = { type: "prompt", text: "解释线性组合的坐标约束" };
const a = { type: "answer_key", text: "PRIVATE_KEY_SENTINEL", ...pedagogy };
const teach = { type: "text", text: "同一组系数满足全部坐标", citedChunkIds: ["allowed"] };
const chunk = (patch: Partial<SourceChunk> = {}): SourceChunk => ({ id: "allowed", sourceId: SOURCE, sourceVersion: 2, page: 3,
  slideLabel: null, startMs: null, endMs: null, text: "authorized vector equations", imageObjectKey: null, ...patch });
const focus: TeachingLearnerFocus = { skillLabel: "span", requirementKey: "span", activityKind: "targeted_explain", reasonCode: "verified_incorrect",
  focusObservationId: "00000000-0000-4000-8000-0000000000d1", recentAssistance: [], strategyVersion: "adaptive-1",
  prerequisiteRepair: { nodeId: SOURCE, targetNodeId: HELD, skillLabel: "equations", returnToSkillLabel: "span", maxMinutes: 5,
    reason: "当前先修确有错误", stopCondition: "写对第一步或达到五分钟后返回原技能" } };

describe("publication validates question/key pairing before any library write", () => {
  it.each([
    { name: "two prompts then two answers", blocks: [teach, q, q, a, a] },
    { name: "intervening teach before first answer", blocks: [teach, q, teach, a, q, a] },
    { name: "orphan key at beginning", blocks: [teach, a, q, a, q, a] },
    { name: "orphan key at end", blocks: [teach, q, a, q, a, a] },
    { name: "last prompt lacks answer", blocks: [teach, q, a, q] },
  ])("$name", async ({ blocks }) => {
    const writeLibraryBlocks = vi.fn();
    await expect(createCompilerBuildPublishInput({ requireModelOutput: true, writeLibraryBlocks })({}, payload, { text: JSON.stringify({ blocks }) }))
      .rejects.toThrow("each check must be immediately followed");
    expect(writeLibraryBlocks).not.toHaveBeenCalled();
  });
  it.each([
    { name: "two scored prompts", blocks: [teach, q, a, q, a] },
    { name: "no prompt", blocks: [teach] }, { name: "unpaired answer", blocks: [teach, a] },
    { name: "gap between prompt and answer", blocks: [teach, q, teach, a] },
    { name: "one prompt with two keys", blocks: [teach, q, a, a] },
  ])("prerequisite prelude cannot publish $name", async ({ blocks }) => {
    const writeLibraryBlocks = vi.fn();
    await expect(createCompilerBuildPublishInput({ learnerFocus: focus, requireModelOutput: true, writeLibraryBlocks })({}, payload, { text: JSON.stringify({ blocks }) }))
      .rejects.toThrow("one original-target prompt immediately followed");
    expect(writeLibraryBlocks).not.toHaveBeenCalled();
  });
  it("one original-target prompt is accepted after an unscored bounded prelude", async () => {
    let written: Parameters<typeof projectClientSafeLibraryBlocks>[0] = [];
    await createCompilerBuildPublishInput({ learnerFocus: focus, requireModelOutput: true, writeLibraryBlocks: async blocks => { written = blocks; } })(
      {}, payload, { text: JSON.stringify({ blocks: [teach, { type: "steps", text: "1. 提醒必要前置\n2. 返回原技能" }, q, a] }) });
    expect(written.map(block => block.role)).toEqual(["teach", "teach", "prompt", "answer_key"]);
    expect(JSON.stringify(projectClientSafeLibraryBlocks(written))).not.toContain("PRIVATE_KEY_SENTINEL");
  });
  it.each([
    { name: "only prompt cites", blocks: [{ ...teach, citedChunkIds: [] }, { ...q, citedChunkIds: ["allowed"] }, a, q, a] },
    { name: "only hidden key cites", blocks: [{ ...teach, citedChunkIds: [] }, q, { ...a, citedChunkIds: ["allowed"] }, q, a] },
    { name: "only forged citation", blocks: [{ ...teach, citedChunkIds: ["forged"] }, q, a, q, a] },
  ])("material minimum cannot be satisfied by $name", async ({ blocks }) => {
    const writeLibraryBlocks = vi.fn();
    await expect(createCompilerBuildPublishInput({ requireModelOutput: true, requireMaterialCitations: true,
      loadChunks: async () => [chunk()], writeLibraryBlocks })({}, payload, { text: JSON.stringify({ blocks }) }))
      .rejects.toThrow("teaching block citing the material evidence pack");
    expect(writeLibraryBlocks).not.toHaveBeenCalled();
  });
  it.each(["text", "formula", "example", "steps"] as const)("material minimum accepts a %s citation without certifying factual support", async type => {
    let written: Parameters<typeof projectClientSafeLibraryBlocks>[0] = [];
    const published = await createCompilerBuildPublishInput({ requireModelOutput: true, requireMaterialCitations: true,
      loadChunks: async () => [chunk()], writeLibraryBlocks: async blocks => { written = blocks; } })({}, payload,
      { text: JSON.stringify({ blocks: [{ ...teach, type }, q, a, q, a] }) });
    expect(published).toMatchObject({ expectedVersion: 4, revisionNumber: 3, verificationStatus: "needs_check" });
    expect(written[0]!.content.citationBinding).toMatchObject({ status: "bound", factualSupport: "unverified" });
  });
});

describe("evidence denylist/privacy boundaries are enforced before provider or publication", () => {
  it.each(["denylist-source", "privacy-source"] as const)("%s removes held content while keeping the authorized source", async boundary => {
    const options = { loadChunks: async () => [chunk(), chunk({ id: "held", sourceId: HELD, text: "PRIVATE_HELD_CONTENT" })],
      ...(boundary === "privacy-source" ? { privacyExcludedSourceIds: [HELD] }
        : { denylist: { sourceIds: [HELD] } }) };
    const provider = await createCompilerProviderInput(options)({}, payload);
    expect(provider.chunks.map(row => row.id)).toEqual(["allowed"]);
    expect(JSON.stringify(provider)).not.toContain("PRIVATE_HELD_CONTENT");
    let written: Parameters<typeof projectClientSafeLibraryBlocks>[0] = [];
    const published = await createCompilerBuildPublishInput({ ...options, requireModelOutput: true,
      writeLibraryBlocks: async blocks => { written = blocks; } })({}, payload,
      { text: JSON.stringify({ blocks: [teach, q, a, q, a] }) });
    expect(published.sourceRefs?.every(ref => ref.sourceId !== HELD)).toBe(true);
    expect(JSON.stringify(written)).not.toContain("PRIVATE_HELD_CONTENT");
  });
  it("private problem ids in chunk identity are guarded even without a rendered context blob", () => {
    expect(() => assertNoHeldOutLeak({ packSourceIds: [SOURCE], packChunkIds: ["prefix:held-problem:chunk"], denylist: { problemIds: ["held-problem"] } }))
      .toThrow("denied problemId in chunkId");
    expect(() => assertNoHeldOutLeak({ packSourceIds: [SOURCE], packChunkIds: ["plain"], denylist: { problemIds: [""] } })).not.toThrow();
  });
  it.each([
    { name: "problem identity in chunk id", denylist: { problemIds: ["held-problem"] }, held: chunk({ id: "held-problem:chunk", text: "plain text" }) },
    { name: "problem identity in text", denylist: { problemIds: ["held-problem"] }, held: chunk({ id: "other", text: "held-problem secret" }) },
    { name: "denied path in text", denylist: { paths: ["private/held-item"] }, held: chunk({ id: "other", text: "private/held-item secret" }) },
  ])("$name fails closed instead of silently dropping an unsupported private reference", async ({ denylist, held }) => {
    const loadChunks = async () => [chunk(), held], writeLibraryBlocks = vi.fn();
    await expect(createCompilerProviderInput({ loadChunks, denylist })({}, payload)).rejects.toThrow("held-out leak");
    await expect(createCompilerBuildPublishInput({ loadChunks, denylist, writeLibraryBlocks })({}, payload, null)).rejects.toThrow("held-out leak");
    expect(writeLibraryBlocks).not.toHaveBeenCalled();
  });
  it("the current authorized loader cannot be bypassed by an old pinned excerpt", async () => {
    const loadChunks = vi.fn().mockResolvedValue([chunk()]);
    const build = createCompilerBuildPublishInput({ loadChunks, evidenceChunks: [chunk({ sourceId: HELD, id: "private-removed", text: "PRIVATE_REVOKED" })] });
    await expect(build({}, payload, null)).rejects.toThrow("evidence is unavailable");
  });
  it("source membership filters a provider pack even if the loader returns extra chunks", async () => {
    const provider = await createCompilerProviderInput({ loadChunks: async () => [chunk(), chunk({ sourceId: HELD, id: "outside", text: "PRIVATE_UNREQUESTED" })] })(
      {}, { ...payload, sourceIds: [SOURCE] });
    expect(provider.chunks.map(row => row.id)).toEqual(["allowed"]);
    expect(JSON.stringify(provider)).not.toContain("PRIVATE_UNREQUESTED");
  });
});

describe("reference arithmetic checks are exact only in the supported prompt branch", () => {
  it.each(["2", "0", "1/2+1/2=2/4=1"])("rejects contradictory reference %s", text => {
    expect(() => parseCompileModelOutput(JSON.stringify({ blocks: [teach, { type: "prompt", text: "计算 1/2+1/2" }, { ...a, text }] }), new Set()))
      .toThrow("arithmetic question and reference solution disagree");
  });
  it.each([undefined, { kind: "numeric" }, { kind: "numeric", unit: "" }])("unitless arithmetic %# cannot skip the exact check", interaction => {
    expect(() => parseCompileModelOutput(JSON.stringify({ blocks: [teach, { type: "prompt", text: "计算 1/2+1/2", interaction }, { ...a, text: "2" }] }), new Set()))
      .toThrow(TeachingCompileOutputError);
  });
  it.each([{ kind: "numeric", unit: "厘米" }, { kind: "choice", options: [{ id: "a", label: "1" }, { id: "b", label: "2" }] }])("unsupported arithmetic branch stays unverified rather than claiming exact support %#", interaction => {
      const parsed = parseCompileModelOutput(JSON.stringify({ blocks: [teach, { type: "prompt", text: "计算 1/2+1/2", interaction }, { ...a, text: "2" }] }), new Set());
      expect(parsed.blocks).toHaveLength(3);
    });
});
