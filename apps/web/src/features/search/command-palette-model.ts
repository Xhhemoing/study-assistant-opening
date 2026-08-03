export type PaletteKeyAction = "next" | "previous" | "select" | "close" | "none";

export const SEARCH_DEBOUNCE_MS = 150;

export const PALETTE_COMMANDS = [
  { id: "new-note", label: "新建笔记", description: "打开一个空白笔记", href: "/library/new" },
  { id: "new-exploration", label: "开始探索", description: "进入自由探索空间", href: "/explore" },
  { id: "new-goal", label: "创建目标", description: "设置一个新的学习目标", href: "/learn/goals/new" },
] as const;

export function getPaletteKeyAction(key: string): PaletteKeyAction {
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Enter") return "select";
  if (key === "Escape") return "close";
  return "none";
}

export function getNextPaletteIndex(
  currentIndex: number,
  action: "next" | "previous",
  optionCount: number,
): number {
  if (optionCount === 0) return -1;
  if (action === "next") return (currentIndex + 1 + optionCount) % optionCount;
  return (currentIndex - 1 + optionCount) % optionCount;
}
