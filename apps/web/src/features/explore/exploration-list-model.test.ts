import { describe, expect, it } from "vitest";
import {
  EXPLORATION_STARTERS,
  explorationPath,
  explorationStatusLabel,
} from "./exploration-list-model";

describe("exploration list model", () => {
  it("keeps three starter prompts in a stable order", () => {
    expect(EXPLORATION_STARTERS).toHaveLength(3);
    expect(EXPLORATION_STARTERS.map((starter) => starter.label)).toEqual([
      "帮我理解一个概念",
      "整理一段资料",
      "分析网页内容",
    ]);
  });

  it("labels statuses and encodes exploration detail paths", () => {
    expect(explorationStatusLabel("open")).toBe("进行中");
    expect(explorationStatusLabel("closed")).toBe("已结束");
    expect(explorationPath("explore/1")).toBe("/explore/explore%2F1");
  });
});
