export type PaletteKeyAction = "next" | "previous" | "select" | "close" | "none";
export const SEARCH_DEBOUNCE_MS = 150;

/** Default palette keeps the Opening learning loop; demoted surfaces stay out of the list. */
export const PALETTE_COMMANDS = [
  { id: "today", label: "今日学习", description: "继续今天的学习任务", href: "/opening/today", kind: "page" },
  { id: "assistant", label: "学习助手", description: "提问并查看学习对话", href: "/opening/assistant", kind: "page" },
  { id: "courses", label: "课程", description: "查看课程与长期学习上下文", href: "/opening/courses", kind: "page" },
  { id: "cards", label: "记忆卡片", description: "复习到期的记忆卡片", href: "/opening/cards", kind: "page" },
  { id: "opening-review", label: "待确认建议", description: "审核助手生成的学习建议", href: "/opening/review", kind: "page" },
  { id: "connections", label: "数据连接", description: "邮箱与钉钉等数据连接设置", href: "/opening/settings/connections", kind: "page" },
  { id: "search", label: "全局搜索", description: "搜索笔记和课程", href: "/search", kind: "page" },
  { id: "settings", label: "设置", description: "数据连接、排程与学习偏好", href: "/settings", kind: "page" },
  { id: "settings-advanced", label: "高级设置", description: "AI 模型、默认入口与诊断", href: "/settings/advanced", kind: "page" },
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
