export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "courses" | "assistant" | "library";
  group: "core";
};

/** The same four destinations on desktop and mobile. Tools live in the account menu. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
    { href: "/opening/agent", label: "助理", icon: "assistant", group: "core" },
    { href: "/opening/library", label: "资料", icon: "library", group: "core" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  if (hrefPath === "/opening/today" && ["/opening/review", "/opening/cards", "/opening/suggestions"].some(path => pathname === path || pathname.startsWith(`${path}/`))) return true;
  if (hrefPath === "/opening/courses" && (pathname === "/opening/sprint" || pathname.startsWith("/opening/sprint/"))) return true;
  if (hrefPath === "/opening/review" && (pathname === "/opening/cards" || pathname.startsWith("/opening/cards/"))) return true;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}
