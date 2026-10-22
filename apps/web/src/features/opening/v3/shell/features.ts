/**
 * 功能注册表：路由、导航位置、布局模板、层级与现有实现的唯一来源。
 * 导航、激活态、过渡方向、手机「更多」、设置子页都从这里派生；新增功能只加一行。
 * source 指向仓库里当前承载该路由的组件，迁移时按它替换外壳、保留数据逻辑。
 */
export type FeatureIcon =
  | "start" | "courses" | "review" | "library" | "sprint" | "cards" | "search" | "settings"
  | "assistant" | "add" | "exam" | "upload" | "connections" | "export" | "advanced" | "measure" | "canvas";

export type FeatureLayout = "start" | "thread" | "list" | "course" | "workspace" | "reader" | "canvas" | "form" | "settings" | "auth" | "redirect";

export type Feature = {
  id: string;
  /** 路由模式，[x] 为动态段 */
  route: string;
  label: string;
  icon: FeatureIcon;
  /** core：一级；tool：学习工具；system：设置；none：不进导航 */
  placement: "core" | "tool" | "system" | "none";
  /** 0 一级、1 二级（列表/课程/设置子页）、2 任务（工作区/阅读/表单） */
  depth: 0 | 1 | 2;
  layout: FeatureLayout;
  /** 激活哪个导航入口（默认自身或最近的一级祖先） */
  parent?: string;
  /** 仓库现有实现，迁移对照 */
  source: string;
};

export const FEATURES: Feature[] = [
  { id: "today", route: "/opening/today", label: "开始", icon: "start", placement: "core", depth: 0, layout: "start", source: "features/opening/planning/today-dashboard" },
  { id: "suggestions", route: "/opening/suggestions", label: "建议", icon: "start", placement: "none", depth: 0, layout: "redirect", parent: "today", source: "app/(opening)/opening/suggestions → /opening/today" },
  { id: "assistant", route: "/opening/assistant", label: "对话", icon: "assistant", placement: "none", depth: 1, layout: "thread", parent: "today", source: "features/opening/assistant/assistant-entry" },
  { id: "courses", route: "/opening/courses", label: "课程", icon: "courses", placement: "core", depth: 0, layout: "list", source: "app/(opening)/opening/courses/page" },
  { id: "course-new", route: "/opening/courses/new", label: "新建课程", icon: "add", placement: "none", depth: 2, layout: "form", parent: "courses", source: "features/courses/course-create" },
  { id: "course", route: "/opening/courses/[id]", label: "课程空间", icon: "courses", placement: "none", depth: 1, layout: "course", parent: "courses", source: "features/courses/course-detail" },
  { id: "course-exam", route: "/opening/courses/[id]/exam", label: "考试", icon: "exam", placement: "none", depth: 2, layout: "form", parent: "courses", source: "features/opening/exam-sprint/course-exam-view" },
  { id: "study", route: "/opening/courses/[id]/study", label: "学习", icon: "courses", placement: "none", depth: 2, layout: "workspace", parent: "courses", source: "features/opening/study/*" },
  { id: "study-span", route: "/opening/courses/[id]/study/span", label: "向量张成", icon: "canvas", placement: "none", depth: 2, layout: "canvas", parent: "courses", source: "features/opening/teaching/span/span-lesson-session" },
  { id: "study-matrix", route: "/opening/courses/[id]/study/matrix", label: "矩阵变换", icon: "canvas", placement: "none", depth: 2, layout: "canvas", parent: "courses", source: "features/courses/course-matrix-lesson" },
  { id: "review", route: "/opening/review", label: "复习", icon: "review", placement: "core", depth: 0, layout: "list", source: "features/opening/review/review-hub" },
  { id: "library", route: "/opening/library", label: "资料", icon: "library", placement: "core", depth: 0, layout: "list", source: "app/(opening)/opening/library/page" },
  { id: "library-new", route: "/opening/library/new", label: "上传资料", icon: "upload", placement: "none", depth: 2, layout: "form", parent: "library", source: "features/editor/new-document" },
  { id: "document", route: "/opening/library/[id]", label: "资料", icon: "library", placement: "none", depth: 2, layout: "reader", parent: "library", source: "features/editor/document-editor（原生文档）/ PDF·照片阅读" },
  { id: "sprint", route: "/opening/sprint", label: "冲刺", icon: "sprint", placement: "tool", depth: 0, layout: "list", source: "features/opening/exam-sprint/sprint-course-chooser" },
  { id: "cards", route: "/opening/cards", label: "卡组", icon: "cards", placement: "tool", depth: 0, layout: "list", source: "features/opening/review/review-route (legacyCardsHref)" },
  { id: "search", route: "/opening/search", label: "搜索", icon: "search", placement: "tool", depth: 0, layout: "list", source: "features/search/search-workspace" },
  { id: "settings", route: "/opening/settings", label: "设置", icon: "settings", placement: "system", depth: 0, layout: "settings", source: "app/(opening)/opening/settings/page" },
  { id: "settings-connections", route: "/opening/settings/connections", label: "连接", icon: "connections", placement: "none", depth: 1, layout: "settings", parent: "settings", source: "features/opening/connections/connection-settings" },
  { id: "settings-export", route: "/opening/settings/export", label: "导出", icon: "export", placement: "none", depth: 1, layout: "settings", parent: "settings", source: "app/(opening)/opening/settings/export/page" },
  { id: "settings-learning-test", route: "/opening/settings/learning-test", label: "学习测试", icon: "measure", placement: "none", depth: 1, layout: "settings", parent: "settings", source: "features/opening/measurement/measurement-view" },
  { id: "settings-advanced", route: "/opening/settings/advanced", label: "高级", icon: "advanced", placement: "none", depth: 1, layout: "settings", parent: "settings", source: "app/(opening)/opening/settings/advanced/page" },
  { id: "login", route: "/login", label: "登录", icon: "start", placement: "none", depth: 0, layout: "auth", source: "app/login/page" },
  { id: "register", route: "/register", label: "注册", icon: "start", placement: "none", depth: 0, layout: "auth", source: "app/register/page" },
  { id: "onboarding", route: "/onboarding", label: "开始使用", icon: "start", placement: "none", depth: 0, layout: "auth", source: "features/onboarding" },
];

const byId = new Map(FEATURES.map(feature => [feature.id, feature]));
const patterns = FEATURES
  .map(feature => ({ feature, regex: new RegExp(`^${feature.route.replace(/\[[^\]]+\]/g, "[^/]+")}$`), weight: feature.route.split("/").length * 10 - (feature.route.match(/\[/g)?.length ?? 0) }))
  .sort((a, b) => b.weight - a.weight); // 静态段优先于动态段：/courses/new 先于 /courses/[id]

export function resolveFeature(pathname: string): Feature | null {
  const path = (pathname.split("?")[0] ?? "").replace(/\/$/, "") || "/";
  return patterns.find(entry => entry.regex.test(path))?.feature ?? null;
}

export function featureHref(id: string, params: Record<string, string> = {}): string {
  const feature = byId.get(id);
  if (!feature) throw new Error(`unknown feature ${id}`);
  return feature.route.replace(/\[([^\]]+)\]/g, (_, key: string) => params[key] ?? "");
}

/** 当前路径应高亮的导航入口 id（每个路径只高亮一个） */
export function activeNavId(pathname: string): string | null {
  let feature = resolveFeature(pathname);
  while (feature && feature.placement === "none" && feature.parent) feature = byId.get(feature.parent) ?? null;
  return feature && feature.placement !== "none" ? feature.id : null;
}

/** 过渡方向：进入更深为 forward，返回更浅为 back，同级切换为 swap */
export function navDirection(from: string, to: string): "forward" | "back" | "swap" {
  const a = resolveFeature(from)?.depth ?? 0;
  const b = resolveFeature(to)?.depth ?? 0;
  return b > a ? "forward" : b < a ? "back" : "swap";
}

export const NAV_CORE = FEATURES.filter(feature => feature.placement === "core");
export const NAV_TOOLS = FEATURES.filter(feature => feature.placement === "tool");
export const NAV_SYSTEM = FEATURES.filter(feature => feature.placement === "system");
export const SETTINGS_PAGES = FEATURES.filter(feature => feature.id === "settings" || feature.parent === "settings");
