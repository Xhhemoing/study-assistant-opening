import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PracticeDraftRecovery } from "./practice-draft-recovery";

it("keeps the exact raw answer selectable and offers a concrete course history exit", () => {
  const html = renderToStaticMarkup(createElement(PracticeDraftRecovery, { courseId: "course-id", answer: "a < b\n原始答案", pending: false, onResume() {} }));
  expect(html).toMatch(/readonly=""/i);
  expect(html).toContain("a &lt; b\n原始答案");
  expect(html).toContain("复制原答案");
  expect(html).toContain('/opening/courses/course-id#course-learning-records');
  expect(html).not.toContain('type="submit"');
});

it("shows archived raw answers and a restore action alongside a nondestructive new-practice action", async () => {
  const { PracticeDraftShelf } = await import("./practice-draft-recovery");
  const { emptyPracticeDraft, practiceScope } = await import("./practice-draft");
  const saved = emptyPracticeDraft(practiceScope("course", "ordinary"), { answer: "original <answer>", skillLabel: "保留题目" });
  const active = emptyPracticeDraft(saved.scope, { answer: "current answer" });
  const continuity = {
    draft: active, drafts: [saved, active], ready: true, storageWarning: false, loadError: "", switchError: "",
    patch() { return active; }, requireSaved() {}, reload() {}, restore() { return true; }, startAnother() { return true; },
  };
  const html = renderToStaticMarkup(createElement(PracticeDraftShelf, { continuity }));
  expect(html).toContain("保留此草稿，开始其他练习");
  expect(html).toContain("保留的练习草稿（1）");
  expect(html).toContain("original &lt;answer&gt;");
  expect(html).toContain("切换到此草稿");
  expect(html).toMatch(/readonly=""/i);
});
