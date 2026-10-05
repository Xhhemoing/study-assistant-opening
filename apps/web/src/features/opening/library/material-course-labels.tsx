import { BookOpen } from "lucide-react";
import type { MaterialOrganization } from "./material-organization-client";

const roles: Record<string, string> = { core: "核心教材", optional: "拓展阅读", reference: "参考资料", archive: "归档资料" };
export function MaterialCourseLabels({ sourceId, organization }: { sourceId: string; organization: MaterialOrganization }) {
  const memberships = organization.memberships.filter(item => item.sourceId === sourceId);
  if (!memberships.length) return <p className="px-3 pb-2 text-xs text-zinc-500">待整理</p>;
  return <ul aria-label="材料所属课程" className="flex flex-wrap gap-x-4 gap-y-1 px-3 pb-2 text-xs text-zinc-600">
    {memberships.map(item => <li key={item.courseId} className="flex min-w-0 items-start gap-1.5">
      <BookOpen size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{organization.courses.find(course => course.id === item.courseId)?.title ?? "课程"} · {roles[item.role] ?? item.role}</span>
    </li>)}
  </ul>;
}
