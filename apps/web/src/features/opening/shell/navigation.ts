export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "assistant" | "learn" | "explore" | "library" | "courses";
  group: "core" | "modes";
};

/** Opening keeps one stable shell with three real entry points. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/assistant", label: "助理", icon: "assistant", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  if (href === "/learn" && pathname.startsWith("/learn/courses")) return false;
  if (href === "/library" && pathname.startsWith("/opening/library")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}
