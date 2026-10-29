import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const diagnosticPreference = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnosticPreference.enabled }));
beforeEach(() => { diagnosticPreference.enabled = false; });
import { SpanLesson, isSpanReservedAttempt } from "./span-lesson";
import type { LearningAttempt } from "@aistudy/contracts";
it.each([
  ["span-example-2d", false], ["span-reserved-generated-teaching-independent-2d-1729-0", false],
  ["span-reserved-dependent", true], ["span-reserved-generated-validation-independent-2d-1729-0", true],
  ["span-reserved-generated-retest-independent-2d-1729-0", true],
  ["span-reserved-generated-research-independent-2d-1729-0", false],
])("restores %s without mixing teaching and reserved attempts", (id, expected) => {
  expect(isSpanReservedAttempt({ spanExercise: { id } } as LearningAttempt)).toBe(expected);
});
it.each(["self_study", "overview", "challenge"] as const)("opens new evidence at the actual reserved step for %s", purpose => {
  const html = renderToStaticMarkup(createElement(SpanLesson, {
    courseId: "11111111-1111-4111-8111-111111111111", sourceIds: [], sourceLoadError: true,
    initialIntent: { purpose, timeBudgetMinutes: 15, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" },
    initialNewEvidenceEventId: "22222222-2222-4222-8222-222222222222",
  }));
  expect(html).toContain("离开示范，用服务器发放的保留题检查");
  expect(html).not.toContain("本步骤通过，进入下一道新题");
});
it("keeps the learning action visible and puts observation criteria in diagnostics", () => {
  const render = () => renderToStaticMarkup(createElement(SpanLesson, { courseId: "11111111-1111-4111-8111-111111111111", sourceIds: [], sourceLoadError: true }));
  const ordinary = render(); expect(ordinary).toContain("开始补全新题"); expect(ordinary).not.toContain("本步骤期待观察什么"); expect(ordinary).not.toContain("覆盖知识点");
  diagnosticPreference.enabled = true;
  const diagnostic = render(); expect(diagnostic).toContain("本步骤期待观察什么"); expect(diagnostic).toContain("继续或停止"); expect(diagnostic).toContain("覆盖知识点");
});

it("keeps a full-lesson reload available after an attempt or hint rejects stale evidence", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const session = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 1, retestId: null, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" } as const;
  const html = renderToStaticMarkup(createElement(SpanLesson, { courseId: id, sourceIds: [id], sourceLoadError: false, session: { ...session, sourceIds: [id] }, onReload: () => undefined }));
  expect(html).toContain("重新读取本节");
});
