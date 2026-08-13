import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PromotionCandidate } from "@aistudy/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { CandidatePanel } from "./candidate-panel";

const pending: PromotionCandidate = {
  id: "55555555-5555-4555-8555-555555555504",
  explorationId: "55555555-5555-4555-8555-555555555501",
  turnId: "55555555-5555-4555-8555-555555555503",
  kind: "note",
  title: "熵的直觉解释",
  body: "熵是系统混乱程度的度量。",
  status: "pending",
  promotedTargetId: null,
  createdAt: "2026-08-02T08:00:00.000Z",
};

describe("CandidatePanel", () => {
  it("renders pending candidates with promotion actions", () => {
    const html = renderToStaticMarkup(createElement(CandidatePanel, {
      explorationTitle: "熵到到底是什么",
      candidates: [
        pending,
        { ...pending, id: "55555555-5555-4555-8555-555555555505", title: "已拒绝", status: "rejected" },
      ],
      onCandidateChange: () => undefined,
    }));

    expect(html).toContain("候选沉淀");
    expect(html).toContain("熵的直觉解释");
    expect(html).toContain("转笔记");
    expect(html).toContain("转卡片");
    expect(html).toContain("转题目");
    expect(html).toContain("转为课程");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("已拒绝");
  });
});
