"use client";

import { CourseDetail } from "./course-detail";

/**
 * Legacy /learn/courses/[id] entry.
 *
 * Product decision (access-middleware.test.ts): this path is *not* redirected
 * under Opening release so existing course deep links keep working. Mock goals /
 * guidance were stripped — the page reads the real course API only, same as
 * Opening course detail, with /learn and /library path prefixes.
 */
export function LegacyCourseDetail({ id }: { id: string }) {
  return <CourseDetail id={id} surface="learn" />;
}
