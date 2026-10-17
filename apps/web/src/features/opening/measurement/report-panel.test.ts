import type { MeasurementAttempt, MeasurementOverview } from "@aistudy/contracts";
import { buildMeasurementReport } from "@aistudy/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MeasurementReportPanel } from "./report-panel";

const attempt: MeasurementAttempt = {
  id: "attempt", trialId: "trial", ordinal: 1,
  item: { id: "item", version: "1", skillId: "skill", skillLabel: "选法", familyId: "family", phase: "practice",
    prompt: "如何选取 u？", options: [{ id: "A", label: "x" }] },
  presentedAt: "2026-10-16T00:00:00Z", answeredAt: "2026-10-16T00:01:00Z", dueAt: null, firstAttempt: true,
  helpEvents: [], answer: "A", outcome: "correct", retractedAt: null, retractionReason: null,
  predictions: [], feedback: "已保存的解析", feedbackWithheld: false,
};
const overview: MeasurementOverview = {
  trial: { id: "trial", courseId: "course", unitId: "unit", protocolVersion: "v1", bankVersion: "v1",
    models: [], selectionPolicy: "fixed-common-probes-v1", status: "active", startedAt: attempt.presentedAt, practiceCompletedAt: null },
  attempts: [attempt], nextDueAt: null, report: buildMeasurementReport([attempt]),
};

it("keeps archived-course records and export accessible without offering a rejected write", () => {
  const props = { overview, busy: false, onRetract: vi.fn() };
  const readOnly = renderToStaticMarkup(createElement(MeasurementReportPanel, { ...props, readOnly: true }));
  expect(readOnly).toContain("已保存的解析");
  expect(readOnly).toContain("/api/opening/measurement/export?courseId=course");
  expect(readOnly).not.toContain("<button");
  const active = renderToStaticMarkup(createElement(MeasurementReportPanel, { ...props, readOnly: false }));
  expect(active).toContain("<button");
});
