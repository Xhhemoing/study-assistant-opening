export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "today" | "courses" | "review" | "library";
  group: "core";
};

/** The same four destinations on desktop and mobile. Tools live in the account menu. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日", icon: "today", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
    { href: "/opening/review", label: "复习", icon: "review", group: "core" },
    { href: "/opening/library", label: "资料", icon: "library", group: "core" },
  ];
}

export function navigationIsActive(href: string, pathname: string): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  if (hrefPath === "/opening/review" && (pathname === "/opening/cards" || pathname.startsWith("/opening/cards/"))) return true;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}
