import { validConversationId } from "../opening/assistant/conversation-links";
import { courseStudyHref } from "./course-study-model";

export const courseTabs = [
  { id: "overview", label: "学习" },
  { id: "practice", label: "练习" },
  { id: "review", label: "复习" },
  { id: "materials", label: "资料" },
  { id: "notes", label: "笔记" },
  { id: "progress", label: "进展" },
  { id: "units", label: "单元" },
] as const;
export type CourseTab = typeof courseTabs[number]["id"];

export function readCourseTab(search: string, hash = ""): CourseTab {
  if (hash === "#course-learning-records") return "progress";
  if (hash === "#course-assets" || hash === "#course-media") return "materials";
  if (hash === "#course-knowledge" || hash === "#course-units") return "units";
  const params = new URLSearchParams(search);
  const section = params.get("section");
  const tab = section === "study" ? "overview" : section === "library" ? "materials" : section ?? params.get("tab");
  if (courseTabs.some(item => item.id === tab)) return tab as CourseTab;
  return params.has("mediaSource") ? "materials" : "overview";
}

export function courseTabHref(courseId: string, tab: CourseTab, search = ""): string {
  const params = new URLSearchParams(search);
  params.delete("section");
  const conversations = params.getAll("conversation");
  if (conversations.length !== 1 || !validConversationId(conversations[0]!)) params.delete("conversation");
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
