export type PaletteKeyAction = "next" | "previous" | "select" | "close" | "none";
export const SEARCH_DEBOUNCE_MS = 150;

/** Default palette keeps the Opening learning loop; demoted surfaces stay out of the list. */
export const PALETTE_COMMANDS = [
  { id: "new-note", label: "新建笔记", description: "打开一个空白笔记", href: "/library/new", kind: "command" },
  { id: "today", label: "今日学习", description: "继续今天的学习任务", href: "/opening/today", kind: "page" },
  { id: "assistant", label: "学习助手", description: "提问并查看学习对话", href: "/opening/assistant", kind: "page" },
  { id: "learn", label: "目标学习", description: "查看今日计划", href: "/learn", kind: "page" },
  { id: "library", label: "知识库", description: "查看笔记与材料", href: "/library", kind: "page" },
  { id: "courses", label: "课程", description: "查看课程与长期学习上下文", href: "/opening/courses", kind: "page" },
  { id: "cards", label: "记忆卡片", description: "复习到期的记忆卡片", href: "/opening/cards", kind: "page" },
  { id: "opening-review", label: "待确认建议", description: "审核助手生成的学习建议", href: "/opening/review", kind: "page" },
  { id: "connections", label: "数据连接", description: "邮箱与钉钉等数据连接设置", href: "/opening/settings/connections", kind: "page" },
  { id: "goals", label: "学习目标", description: "管理目标与时间安排", href: "/learn/goals", kind: "page" },
  { id: "review", label: "复习卡片", description: "开始到期卡片复习", href: "/learn/review", kind: "page" },
  { id: "search", label: "全局搜索", description: "搜索笔记和课程", href: "/search", kind: "page" },
  { id: "settings", label: "设置", description: "工作区入口与学习偏好", href: "/settings", kind: "page" },
  { id: "export", label: "导出与备份", description: "下载内容并管理完整备份", href: "/settings/export", kind: "page" },
] as const;

export function filterPaletteCommands(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return PALETTE_COMMANDS.filter((command) => !normalized || `${command.label} ${command.description} ${command.href}`.toLocaleLowerCase().includes(normalized));
}
export function getPaletteKeyAction(key: string, isComposing = false): PaletteKeyAction {
  if (isComposing) return "none";
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Enter") return "select";
  if (key === "Escape") return "close";
  return "none";
}
export function getNextPaletteIndex(currentIndex: number, action: "next" | "previous", optionCount: number): number {
  if (optionCount === 0) return -1;
  if (action === "next") return (currentIndex + 1 + optionCount) % optionCount;
  return (currentIndex - 1 + optionCount) % optionCount;
}
