import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MatrixConceptLesson } from "./matrix-concept-lesson";

vi.mock("../lesson-companion-workspace", () => ({ LessonCompanionWorkspace: ({ children }: { children: ReactNode }) => children }));
vi.mock("./lesson-progress", async importOriginal => {
  const actual = await importOriginal<typeof import("./lesson-progress")>();
  return { ...actual, useMatrixLessonProgress: () => ({
    progress: { ...actual.recordMatrixLessonOriginal({ ...actual.initialMatrixLessonProgress(), draftAnswer: "我的原始思考" }), section: 4 },
    ready: true, storageWarning: false, update: () => {},
  }) };
});

const courseId = "11111111-1111-4111-8111-111111111111";
const conversation = "22222222-2222-4222-8222-222222222222";
describe("matrix lesson fallback practice", () => {
  it.each([null, conversation])("preserves only an explicitly supplied original conversation: %s", originalConversationId => {
    const html = renderToStaticMarkup(createElement(MatrixConceptLesson, {
      courseId, courseTitle: "线性代数", practiceHref: "/practice", delayedPracticeHref: "/delayed",
      interactiveEnabled: false, matrixPracticeEnabled: false, originalConversationId,
    }));
    const link = html.match(/<a[^>]+href="([^"]+)"[^>]*>进入普通独立练习<\/a>/)?.[1]?.replaceAll("&amp;", "&");
    const target = new URL(link!, "https://study.test");
    expect(target.pathname).toBe(`/opening/courses/${courseId}/study`);
    expect(target.searchParams.get("mode")).toBe("practice");
    expect(target.searchParams.getAll("conversation")).toEqual(originalConversationId ? [originalConversationId] : []);
  });
});
