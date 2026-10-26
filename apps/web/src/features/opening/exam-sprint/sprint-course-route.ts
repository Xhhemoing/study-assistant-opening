import { z } from "zod";

export type SprintSearch = Record<string, string | string[] | undefined>;

/** Syntax validation chooses a local route; that route still reads the owned course. */
export function sprintCourseId(search: SprintSearch): string | null {
  const course = z.string().uuid().safeParse(search.courseId);
  return course.success ? course.data : null;
}

export function sprintCourseHref(search: SprintSearch): string | null {
  const courseId = sprintCourseId(search);
  if (!courseId) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (key === "courseId" || key === "mode") continue;
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  params.set("courseId", courseId);
  return `/opening/sprint?${params}`;
}

export function sprintCourseScope(courseId: string | undefined, binding: { courseId: string } | null | undefined) {
  if (!courseId) return "unscoped";
  if (binding === undefined) return "loading";
  if (binding === null) return "unbound";
  return binding.courseId === courseId ? "match" : "other";
}
