import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TodayCourseList } from "./today-course-list";
import type { TodayCourse } from "./today-read";

const course: TodayCourse = { id: "11111111-1111-4111-8111-111111111111", title: "线性代数", archivedAt: null, targetDate: "2026-11-01", learningMode: "exam" };

it("offers canonical exam sprint from the menu only for an active course with an explicit exam date", () => {
  const html = renderToStaticMarkup(<TodayCourseList courses={[course]} />);
  expect(html).toContain('aria-label="线性代数更多操作"');
  expect(html).toContain(`href="/opening/sprint?courseId=${course.id}"`);
  expect(html).toContain("考前冲刺");
});

it.each([
  { ...course, learningMode: "auto" as const },
  { ...course, learningMode: undefined },
  { ...course, targetDate: null },
  { ...course, archivedAt: "2026-10-01" },
])("keeps a generic deadline, no date or archived course from posing as an exam", value => {
  const html = renderToStaticMarkup(<TodayCourseList courses={[value]} />);
  expect(html).not.toContain("考前冲刺");
  expect(html).not.toContain("更多操作");
  expect(html).toContain(`/opening/courses/${course.id}`);
});
