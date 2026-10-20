export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "assistant" | "library" | "courses" | "cards" | "sprint" | "review" | "connections";
  group: "core" | "more";
};

/** Opening shell: core learning loop first, then secondary loop surfaces. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/assistant", label: "助理", icon: "assistant", group: "core" },
    { href: "/opening/library", label: "资料库", icon: "library", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
    { href: "/opening/cards", label: "卡片", icon: "cards", group: "more" },
    { href: "/opening/sprint", label: "考前冲刺", icon: "sprint", group: "more" },
    { href: "/opening/review", label: "待确认", icon: "review", group: "more" },
    { href: "/opening/settings/connections", label: "连接", icon: "connections", group: "more" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}
