import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

vi.mock("../../../../features/courses/course-detail", () => ({
  CourseDetail: vi.fn(({ id, mode, conversationId }: { id: string; mode: string; conversationId?: string }) => <div data-course={id} data-mode={mode} data-conversation={conversationId} />),
}));
vi.mock("../../../../features/opening/exam-sprint/sprint-course-chooser", () => ({
  SprintCourseChooser: ({ invalidCourse }: { invalidCourse: boolean }) => <div data-chooser={String(invalidCourse)} />,
}));
vi.mock("../../../../features/opening/assistant/conversation-object-frame", () => ({
  ConversationObjectFrame: ({ children }: { children: ReactNode }) => children,
}));
import OpeningSprintPage from "./page";
import { CourseDetail } from "../../../../features/courses/course-detail";

const course = "11111111-1111-4111-8111-111111111111";
const conversation = "22222222-2222-4222-8222-222222222222";
it("renders the owned course sprint at the canonical URL instead of redirecting back", async () => {
  const html = renderToStaticMarkup(await OpeningSprintPage({ searchParams: Promise.resolve({ courseId: course, conversation }) }));
  expect(html).toContain(`data-course="${course}"`);
  expect(html).toContain('data-mode="sprint"');
  expect(html).toContain(`data-conversation="${conversation}"`);
});
it.each([{}, { courseId: "invalid" }, { courseId: [course, course] }])("keeps invalid course selectors in the chooser", async search => {
  (CourseDetail as Mock).mockClear();
  const html = renderToStaticMarkup(await OpeningSprintPage({ searchParams: Promise.resolve(search) }));
  expect(html).toContain("data-chooser=");
  expect(CourseDetail).not.toHaveBeenCalled();
});
