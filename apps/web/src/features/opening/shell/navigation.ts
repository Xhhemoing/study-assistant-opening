export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "assistant" | "learn" | "explore" | "library" | "courses";
};

/** Stable entry points retain the three equal learning modes. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today" },
    { href: "/opening/assistant", label: "助理", icon: "assistant" },
    { href: "/learn", label: "学习", icon: "learn" },
    { href: "/explore", label: "探索", icon: "explore" },
    { href: "/library", label: "知识库", icon: "library" },
    { href: "/opening/courses", label: "课程", icon: "courses" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  if (href === "/opening/courses" && pathname.startsWith("/learn/courses")) return true;
  if (href === "/learn" && pathname.startsWith("/learn/courses")) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
