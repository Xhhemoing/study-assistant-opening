import { describe, expect, it } from "vitest";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { assertReferenceTextRevision } from "./opening-teaching-reference-revision";

type Block = { id: string; type: string; content: Record<string, unknown> };
function pair() {
  const order: TeachingBlockRef[] = [
    { blockId: "z-prompt", blockType: "prompt", role: "prompt", position: 0 },
    { blockId: "a-answer", blockType: "answer_key", role: "answer_key", position: 1 },
  ];
  // Unknown prose intentionally abstains: arithmetic rejection cannot hide a missing identity guard.
  const before: Block[] = [
    { id: "z-prompt", type: "prompt", content: { text: "解释本节的核心概念" } },
    { id: "a-answer", type: "answer_key", content: { answer: "旧的参考说明", hidden: true } },
  ];
  const after = structuredClone(before); after[1]!.content.answer = "新的参考说明，仍需人工核对";
  return { order, before, after };
}
function rejected(value: ReturnType<typeof pair>, message = "only bound reference answer text may change") {
  const before = structuredClone(value);
  expect(() => assertReferenceTextRevision(value.order, value.before, value.after)).toThrow(message);
  expect(value).toEqual(before);
}
function accepted(value: ReturnType<typeof pair>) {
  const before = structuredClone(value);
  expect(assertReferenceTextRevision(value.order, value.before, value.after)).toBeUndefined();
  expect(value).toEqual(before);
}

describe("batch2 reference binding isolated predicates; no competing arithmetic veto", () => {
  it("positive prose control establishes a real bound edit with no verification claim", () => accepted(pair()));
  it("prompt reference role veto alone defeats otherwise-valid prompt blockType", () => {
    const f = pair(); f.order[0]!.role = "answer_key"; rejected(f);
    f.order[0]!.role = "prompt"; accepted(f);
  });
  it("prompt role alone admits a reference even when ref blockType is text", () => {
    const f = pair(); f.order[0]!.blockType = "text"; accepted(f);
    f.order[0]!.role = "teach"; rejected(f);
  });
  it.each(["prompt", "question"])("ref blockType %s alone admits prompt when role is teach", blockType => {
    const f = pair(); f.order[0]!.role = "teach"; f.order[0]!.blockType = blockType; accepted(f);
    f.order[0]!.blockType = "text"; rejected(f);
  });
  it("missing saved prompt alone rejects, restoring exact id recovers", () => {
    const f = pair(); f.before[0]!.id = "not-in-order"; f.after[0]!.id = "not-in-order"; rejected(f);
    f.before[0]!.id = "z-prompt"; f.after[0]!.id = "z-prompt"; accepted(f);
  });
  it.each(["prompt", "question"])("saved type %s alone admits; paragraph with same text rejects", type => {
    const f = pair(); f.before[0]!.type = type; f.after[0]!.type = type; accepted(f);
    f.before[0]!.type = "paragraph"; f.after[0]!.type = "paragraph"; rejected(f);
  });
  it("saved blank prompt alone rejects despite live-looking reference identity", () => {
    const f = pair(); f.before[0]!.content.text = "  "; f.after[0]!.content.text = "  "; rejected(f);
    f.before[0]!.content.text = "核心概念"; f.after[0]!.content.text = "核心概念"; accepted(f);
  });
  it("answer ref role alone admits when blockType is text", () => {
    const f = pair(); f.order[1]!.blockType = "text"; accepted(f);
    f.order[1]!.role = "teach"; rejected(f);
  });
  it.each(["answer_key", "solution"])("answer ref blockType %s alone admits when role is teach", blockType => {
    const f = pair(); f.order[1]!.role = "teach"; f.order[1]!.blockType = blockType; accepted(f);
    f.order[1]!.blockType = "text"; rejected(f);
  });
  it.each(["answer_key", "solution"])("saved answer type %s is valid; paragraph type alone rejects", type => {
    const f = pair(); f.before[1]!.type = type; f.after[1]!.type = type; accepted(f);
    f.before[1]!.type = "paragraph"; f.after[1]!.type = "paragraph"; rejected(f);
  });
  it.each(["id", "type", "hidden", "hints"] as const)("changed answer %s is sole rejection even when arithmetic abstains", field => {
    const f = pair(); accepted(f);
    if (field === "id" || field === "type") f.after[1]![field] = "different";
    if (field === "hidden") f.after[1]!.content.hidden = false;
    if (field === "hints") f.after[1]!.content.hints = { direction: "new disclosure" };
    rejected(f, "only reference answer text may change");
  });
});

function twoPairs(ties: boolean, shuffled: boolean) {
  const f = pair();
  f.order.push({ blockId: "y-prompt", blockType: "question", role: "prompt", position: 2 },
    { blockId: "b-answer", blockType: "solution", role: "answer_key", position: 3 });
  f.before.push({ id: "y-prompt", type: "question", content: { text: "解释第二个概念" } },
    { id: "b-answer", type: "solution", content: { answer: "旧第二参考" } });
  f.after.push(structuredClone(f.before[2]!), { ...structuredClone(f.before[3]!), content: { answer: "新第二参考" } });
  if (ties) f.order.forEach((ref, index) => { ref.position = Math.floor(index / 2); });
  if (shuffled) f.order = [f.order[2]!, f.order[3]!, f.order[0]!, f.order[1]!];
  return f;
}

describe("batch2 tie-only order sensitivity distinct from ordinary numeric ordering", () => {
  it.each([false, true])("strict numeric positions accept distinct pairs (shuffled=%s)", shuffled => accepted(twoPairs(false, shuffled)));
  it.each([false, true])("tied positions retain original within-group prompt/answer order (shuffled groups=%s)", shuffled => accepted(twoPairs(true, shuffled)));
  it("changing only within-tie sequence breaks binding while strict positions repair it", () => {
    const f = twoPairs(true, false);
    [f.order[0], f.order[1]] = [f.order[1]!, f.order[0]!]; rejected(f);
    f.order.forEach(ref => { ref.position = ref.blockId === "z-prompt" ? 0 : ref.blockId === "a-answer" ? 1 : ref.blockId === "y-prompt" ? 2 : 3; });
    accepted(f);
  });
});
