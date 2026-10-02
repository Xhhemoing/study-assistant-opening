export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "assistant" | "learn" | "explore" | "library" | "courses";
  group: "core" | "modes";
};

/** Daily core entries come first (notes are the hub); learning modes stay equal and directly reachable. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/assistant", label: "助理", icon: "assistant", group: "core" },
    { href: "/library", label: "知识库", icon: "library", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "modes" },
    { href: "/learn", label: "学习", icon: "learn", group: "modes" },
    { href: "/explore", label: "探索", icon: "explore", group: "modes" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  if (href === "/opening/courses" && pathname.startsWith("/learn/courses")) return true;
  if (href === "/learn" && pathname.startsWith("/learn/courses")) return false;
  if (href === "/library" && pathname.startsWith("/opening/library")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}
