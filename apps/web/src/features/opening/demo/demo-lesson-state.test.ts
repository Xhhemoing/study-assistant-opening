import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { demoLessonReducer, initialDemoLessonState } from "./demo-lesson-state";

vi.mock("next/link", () => ({ default: ({ children, href, prefetch: _prefetch, ...props }: { children: import("react").ReactNode; href: string; prefetch?: boolean }) => createElement("a", { ...props, href }, children) }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => ({ explorePreview: true }) }));
import { AiReadinessChecklistView } from "../assistant/ai-readiness";

it("keeps the demo entry alongside settings only when AI is hard-blocked", () => {
  for (const key of ["provider_key", "daily_budget", "available_model"]) {
    const html = renderToStaticMarkup(createElement(AiReadinessChecklistView, { items: [{ key, ok: false, detail: "未配置", fixHint: "设置", severity: "hard" }] }));
    expect(html).toContain('href="/demo/learning"');
    expect(html).toContain("不调用模型");
    expect(html).toContain("/opening/settings/advanced");
  }
  expect(renderToStaticMarkup(createElement(AiReadinessChecklistView, { items: [] }))).toBe("");
});

it("rejects blank and duplicate submissions, retaining original answers across help and revisions", () => {
  expect(demoLessonReducer(initialDemoLessonState, { type: "submit" })).toBe(initialDemoLessonState);
  const draft = demoLessonReducer(initialDemoLessonState, { type: "edit", text: "  原答  " });
  const submitted = demoLessonReducer(draft, { type: "submit" });
  expect(demoLessonReducer(submitted, { type: "submit" })).toBe(submitted);
  const revised = demoLessonReducer(demoLessonReducer(submitted, { type: "hint" }), { type: "edit", text: "修订" });
  expect(revised.submittedAnswers).toEqual(["  原答  "]);
  expect(revised.hintVisible).toBe(true);
  expect(revised.feedbackVisible).toBe(false);
  expect(demoLessonReducer(revised, { type: "submit" }).submittedAnswers).toEqual(["  原答  ", "修订"]);
  expect(demoLessonReducer(revised, { type: "reset" })).toEqual(initialDemoLessonState);
});
