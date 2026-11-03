import { expect, it, vi } from "vitest";
import CourseHandoutPage from "./page";
import { loadCourseHandout } from "../../../../../../../features/opening/courses/server/course-handout";
import { CourseHandoutReader } from "../../../../../../../features/opening/courses/course-handout-reader";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "fixture-session" }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("../../../../../../../features/opening/courses/server/course-handout", () => ({ loadCourseHandout: vi.fn() }));
it("passes authenticated headers and route identity into the loader and mounts the real reader", async () => {
  const data = { courseId: "course", init: { blocks: [] }, generateStatus: "ready" };
  vi.mocked(loadCourseHandout).mockResolvedValue(data as Awaited<ReturnType<typeof loadCourseHandout>>);
  const page = await CourseHandoutPage({ params: Promise.resolve({ id: "course", activityId: "activity" }) });
  expect(page.type).toBe(CourseHandoutReader);
  expect(page.props).toEqual(data);
  const [request, courseId, activityId] = vi.mocked(loadCourseHandout).mock.calls.at(-1)!;
  expect(request.headers.get("cookie")).toBe("fixture-session");
  expect([courseId, activityId]).toEqual(["course", "activity"]);
});
it("uses the same not-found result for unavailable and unauthorized handouts", async () => {
  vi.mocked(loadCourseHandout).mockResolvedValue(null);
  await expect(CourseHandoutPage({ params: Promise.resolve({ id: "course", activityId: "activity" }) })).rejects.toThrow("NOT_FOUND");
});
