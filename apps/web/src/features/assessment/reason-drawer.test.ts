import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StatusResult } from "@aistudy/contracts";
import { ReasonDrawer } from "./reason-drawer";

const status: StatusResult = {
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  status: "weak",
  summaryMetrics: [],
  reasonCodes: ["recent-failure", "low-confidence"],
  recommendedActions: [{ code: "variant", label: "做一道变式题", estimatedMinutes: 10 }],
  evidenceSnapshotId: "snap-reason",
  strategyVersion: "assess-1",
  modelVersion: "rules-1",
  computedAt: "2026-08-03T08:00:00.000Z",
};

describe("reason drawer", () => {
  it("shows reasons, improvement actions, and correction entry", () => {
    const html = renderToStaticMarkup(createElement(ReasonDrawer, {
      open: true,
      onClose: vi.fn(),
      onCorrection: vi.fn(async () => undefined),
      status,
    }));

    expect(html).toContain("为什么");
    expect(html).toContain("最近一次作答没有答对");
    expect(html).toContain("做一道变式题");
    expect(html).toContain("判断不准");
  });
});
