import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const diagnosticPreference = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => diagnosticPreference.enabled }));
// Focus portal behavior is covered by its real-browser tests; these checks own
// the lesson content independent of the portal's client-only mount point.
vi.mock("@aistudy/ui", async original => ({ ...await original<typeof import("@aistudy/ui")>(), LessonFocusDialog: ({ children }: { children: ReactNode }) => children }));
beforeEach(() => { diagnosticPreference.enabled = false; });
import { SpanLesson } from "./span-lesson";
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
