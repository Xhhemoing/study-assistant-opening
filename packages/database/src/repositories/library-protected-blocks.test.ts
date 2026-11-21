import { describe, expect, it } from "vitest";
import {
  collectProposalProtectedBlockIds,
  collectProtectedBlockIds,
  excludeAnswerKeys,
  hasForgedOrProtectedBlock,
  mergePreservedProtectedBlocks,
} from "./library-protected-blocks";

const visibleA = { id: "11111111-1111-4111-8111-111111111111", type: "paragraph", position: 1, content: { text: "A" } };
const visibleB = { id: "22222222-2222-4222-8222-222222222222", type: "paragraph", position: 3, content: { text: "B" } };
const leadAnswer = { id: "33333333-3333-4333-8333-333333333333", type: "answer_key", position: 0, content: { answer: "LEAD" } };
const midSolution = { id: "44444444-4444-4444-8444-444444444444", type: "solution", position: 2, content: { solution: "MID" } };
const midProvenance = { id: "55555555-5555-4555-8555-555555555555", type: "paragraph", position: 4, content: { text: "PROV" } };
const trailAnswer = { id: "66666666-6666-4666-8666-666666666666", type: "text", position: 5, content: { role: "answer_key", text: "TRAIL" } };

describe("library protected block helpers", () => {
  it("excludes inline, nested, and provenance-registered answer blocks case-insensitively", () => {
    const isVisible = excludeAnswerKeys([midProvenance.id.toUpperCase()]);
    const existing = [leadAnswer, visibleA, midSolution, visibleB, midProvenance, trailAnswer];
    expect(existing.filter(isVisible).map((b) => b.id)).toEqual([visibleA.id, visibleB.id]);

    const protectedIds = collectProtectedBlockIds(existing, [midProvenance.id.toUpperCase()]);
    expect([...protectedIds].sort()).toEqual([leadAnswer.id, midSolution.id, midProvenance.id, trailAnswer.id].sort());
  });

  it("detects forged answer markers and case-insensitive protected ID collisions", () => {
    const protectedIds = new Set([leadAnswer.id, midProvenance.id]);

    expect(hasForgedOrProtectedBlock([visibleA, visibleB], protectedIds)).toBe(false);
    expect(hasForgedOrProtectedBlock([{ ...visibleA, id: midProvenance.id.toUpperCase() }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "answer_key", content: { answer: "x" } }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "solution", content: { text: "x" } }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "paragraph", role: "answer_key", content: { text: "x" } }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "paragraph", blockType: "solution", content: { text: "x" } }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "text", content: { role: "solution", text: "x" } }], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([{ id: "77777777-7777-4777-8777-777777777777", type: "text", content: { blockType: "answer_key", text: "x" } }], protectedIds)).toBe(true);
  });

  it("preserves protected blocks deterministically around edits, removals, and additions", () => {
    const existing = [leadAnswer, visibleA, midSolution, visibleB, midProvenance, trailAnswer];
    const isVisible = excludeAnswerKeys([midProvenance.id]);
    const editedA = { ...visibleA, position: 0, content: { text: "A_EDITED" } };
    const addedC = { id: "88888888-8888-4888-8888-888888888888", type: "paragraph", position: 1, content: { text: "C_ADDED" } };

    const merged = mergePreservedProtectedBlocks(existing, [editedA, addedC], isVisible);
    expect(merged.map((b) => b.id)).toEqual([
      leadAnswer.id,
      editedA.id,
      midSolution.id,
      addedC.id,
      midProvenance.id,
      trailAnswer.id,
    ]);
    expect(merged.map((b) => b.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("unites live protected IDs with legacy historical answer IDs across proposal snapshots", () => {
    const deletedHistoricalAnswer = {
      id: "99999999-9999-4999-8999-999999999999",
      type: "answer_key",
      position: 0,
      content: { answer: "HISTORICAL_SECRET" },
    };
    const conflictAnswer = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "solution",
      position: 1,
      content: { solution: "CONFLICT_SECRET" },
    };
    const untaggedCopy = {
      id: deletedHistoricalAnswer.id.toUpperCase(),
      type: "paragraph",
      position: 0,
      content: { text: "HISTORICAL_SECRET" },
    };

    const protectedIds = collectProposalProtectedBlockIds(new Set([leadAnswer.id.toUpperCase()]), {
      baseBlocks: [deletedHistoricalAnswer, visibleA],
      proposedBlocks: [untaggedCopy, visibleA],
      diff: [{ blockId: deletedHistoricalAnswer.id, kind: "changed", base: deletedHistoricalAnswer, proposed: untaggedCopy }],
      conflict: { currentBlocks: [visibleA, conflictAnswer] },
    });

    expect([...protectedIds].sort()).toEqual([
      leadAnswer.id,
      deletedHistoricalAnswer.id,
      conflictAnswer.id,
    ].sort());
    expect(hasForgedOrProtectedBlock([untaggedCopy], protectedIds)).toBe(true);
    expect(hasForgedOrProtectedBlock([visibleA], protectedIds)).toBe(false);
  });
});
