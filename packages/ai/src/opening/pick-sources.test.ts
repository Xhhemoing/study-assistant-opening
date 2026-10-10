import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import {
  DEFAULT_PICK_SOURCES_K,
  clampPickSourcesK,
  pickSourceIds,
  shouldAutoPickSources,
} from "./pick-sources";

const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";
const S3 = "00000000-0000-4000-8000-000000000003";
const S4 = "00000000-0000-4000-8000-000000000004";
const S5 = "00000000-0000-4000-8000-000000000005";
const S6 = "00000000-0000-4000-8000-000000000006";
const S7 = "00000000-0000-4000-8000-000000000007";
const S8 = "00000000-0000-4000-8000-000000000008";
const S9 = "00000000-0000-4000-8000-000000000009";

const chunk = (
  id: string,
  sourceId: string,
  text: string,
): SourceChunk => ({
  id,
  sourceId,
  sourceVersion: 0,
  page: 1,
  slideLabel: null,
  startMs: null,
  endMs: null,
  text,
  imageObjectKey: null,
});

describe("pickSourceIds", () => {
  it("documents default K=6 clamped to 3–8", () => {
    expect(DEFAULT_PICK_SOURCES_K).toBe(6);
    expect(clampPickSourcesK()).toBe(6);
    expect(clampPickSourcesK(1)).toBe(3);
    expect(clampPickSourcesK(100)).toBe(8);
    expect(clampPickSourcesK(5)).toBe(5);
  });

  it("returns stable top-K for English fixtures independent of input order", () => {
    const chunks = [
      chunk("a", S1, "gardening tips and soil"),
      chunk("b", S2, "Newton wrote the laws of motion"),
      chunk("c", S3, "Einstein refined gravity"),
      chunk("d", S4, "Momentum is conserved in collisions"),
      chunk("e", S5, "Recipes for soup"),
      chunk("f", S6, "Newton and force F=ma"),
      chunk("g", S7, "Travel packing lists"),
      chunk("h", S8, "Unrelated chess openings"),
      chunk("i", S9, "Newton gravity and motion together"),
    ];
    const sourceIds = [S1, S2, S3, S4, S5, S6, S7, S8, S9];
    const expected = pickSourceIds({
      chunks,
      query: "Newton motion laws",
      sourceIds,
      k: 6,
    });
    expect(expected).toHaveLength(6);
    // S2 ("Newton…laws…motion") outranks S9/S6; gardening/travel stay out.
    expect(expected[0]).toBe(S2);
    expect(expected).toContain(S9);
    expect(expected).toContain(S6);
    // Zero-score fillers (S1/S5/…) may still occupy remaining K slots by sourceId.
    expect(
      pickSourceIds({ chunks: [...chunks].reverse(), query: "Newton motion laws", sourceIds: [...sourceIds].reverse(), k: 6 }),
    ).toEqual(expected);
  });

  it("returns stable top-K for Chinese fixtures", () => {
    const chunks = [
      chunk("a", S1, "今日菜谱与食材准备"),
      chunk("b", S2, "贝叶斯模型用于知识追踪"),
      chunk("c", S3, "牛顿运动定律概述"),
      chunk("d", S4, "贝叶斯定理与后验概率"),
      chunk("e", S5, "旅游行程安排"),
      chunk("f", S6, "知识追踪实验记录"),
      chunk("g", S7, "象棋开局手册"),
      chunk("h", S8, "贝叶斯与知识追踪综合"),
      chunk("i", S9, "天气预报与穿衣建议"),
    ];
    const sourceIds = [S1, S2, S3, S4, S5, S6, S7, S8, S9];
    const expected = pickSourceIds({
      chunks,
      query: "请解释贝叶斯模型如何用于知识追踪",
      sourceIds,
      k: 6,
    });
    expect(expected).toHaveLength(6);
    // S2 has the densest 贝叶斯/知识追踪 overlap with the full-sentence query.
    expect(expected[0]).toBe(S2);
    expect(expected).toContain(S8);
    expect(expected).toContain(S4);
    expect(
      pickSourceIds({
        chunks: [...chunks].reverse(),
        query: "请解释贝叶斯模型如何用于知识追踪",
        sourceIds: [...sourceIds].reverse(),
        k: 6,
      }),
    ).toEqual(expected);
  });

  it("keeps all sources when set size is at most K, sorted by id", () => {
    const chunks = [
      chunk("b", S2, "match"),
      chunk("a", S1, "other"),
    ];
    expect(pickSourceIds({ chunks, query: "match", sourceIds: [S2, S1], k: 6 })).toEqual([
      S1,
      S2,
    ]);
  });

  it("still returns stable K sources when every score is zero", () => {
    const sourceIds = [S9, S1, S5, S3, S7, S2, S8, S4, S6];
    const chunks = sourceIds.map((id, i) => chunk(`c${i}`, id, "unrelated filler text"));
    const picked = pickSourceIds({ chunks, query: "完全不相关的问题词", sourceIds, k: 6 });
    expect(picked).toHaveLength(6);
    expect(picked).toEqual([...sourceIds].sort((a, b) => a.localeCompare(b)).slice(0, 6));
  });

  it("shouldAutoPickSources only when client empty and pool larger than K", () => {
    expect(shouldAutoPickSources([], [S1, S2, S3, S4, S5, S6, S7])).toBe(true);
    expect(shouldAutoPickSources([], [S1, S2, S3])).toBe(false);
    expect(shouldAutoPickSources([S1], [S1, S2, S3, S4, S5, S6, S7])).toBe(false);
  });
});
