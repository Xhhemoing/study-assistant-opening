export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "assistant" | "learn" | "explore" | "library" | "courses" | "cards" | "review" | "connections";
  group: "core" | "more";
};

/** Opening shell: core learning loop first, then secondary loop surfaces. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/assistant", label: "助理", icon: "assistant", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
    { href: "/opening/cards", label: "卡片", icon: "cards", group: "more" },
    { href: "/opening/review", label: "待确认", icon: "review", group: "more" },
    { href: "/opening/settings/connections", label: "连接", icon: "connections", group: "more" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  if (href === "/learn" && pathname.startsWith("/learn/courses")) return false;
  if (href === "/library" && pathname.startsWith("/opening/library")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}
