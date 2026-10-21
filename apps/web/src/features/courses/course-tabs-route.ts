import { courseStudyHref } from "./course-study-model";

export const courseTabs = [
  { id: "overview", label: "概览" },
  { id: "units", label: "单元" },
  { id: "progress", label: "进展" },
  { id: "materials", label: "资料" },
] as const;
export type CourseTab = typeof courseTabs[number]["id"];

export function readCourseTab(search: string, hash = ""): CourseTab {
  if (hash === "#course-learning-records") return "progress";
  if (hash === "#course-assets" || hash === "#course-media") return "materials";
  if (hash === "#course-knowledge" || hash === "#course-units") return "units";
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  if (courseTabs.some(item => item.id === tab)) return tab as CourseTab;
  return params.has("mediaSource") ? "materials" : "overview";
}

export function courseTabHref(courseId: string, tab: CourseTab, search = ""): string {
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return `/opening/courses/${encodeURIComponent(courseId)}?${params}`;
}

/** Legacy links carry an execution target; the study entry remains its validator. */
export function legacyCourseStudyHref(courseId: string, search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get("retest") && hash !== "#course-practice") return null;
  params.delete("tab");
  if (params.has("skillLabel") && !params.has("mode") && !["activity", "task", "retest", "after"].some(key => params.has(key))) {
    params.set("mode", "practice");
  }
  const query = params.toString();
  return `${courseStudyHref(courseId)}${query ? `?${query}` : ""}`;
}
