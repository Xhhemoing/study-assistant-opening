import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AttemptEvent, StatusResult } from "@aistudy/contracts";
import { ResultSummary } from "./result-summary";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const event: AttemptEvent = {
  id: "77777777-7777-4777-8777-777777777701",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  practiceItemId: "22222222-2222-4222-8222-222222222201",
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  idempotencyKey: "result-view-001",
  answer: "A",
  correct: false,
  assisted: true,
  durationMs: 12000,
  hintCount: 1,
  confidence: 2,
  errorCause: "concept",
  abilitySlice: "recall",
  contentVersion: 1,
  schemaVersion: 1,
  createdAt: "2026-08-03T08:00:00.000Z",
};

const status: StatusResult = {
  syllabusPointId: event.syllabusPointId,
  status: "weak",
  summaryMetrics: [{ key: "coverage", label: "证据覆盖", value: "2/6" }],
  reasonCodes: ["recent-failure"],
  recommendedActions: [{ code: "variant", label: "做一道变式题", estimatedMinutes: 10 }],
  evidenceSnapshotId: "snap-result",
  strategyVersion: "assess-1",
  modelVersion: "rules-1",
  computedAt: "2026-08-03T08:00:00.000Z",
};

describe("result summary", () => {
  it("shows the verdict, evidence treatment, status, and reason entry point", () => {
    const html = renderToStaticMarkup(createElement(ResultSummary, {
      data: { event, status },
      nextHref: "/learn",
      onOpenReason: vi.fn(),
    }));

    expect(html).toContain("这次作答还需要巩固");
    expect(html).toContain("看过答案，本次不计入独立有效证据");
    expect(html).toContain("薄弱");
    expect(html).toContain("为什么");
    expect(html).toContain("继续今日计划");
  });
});
