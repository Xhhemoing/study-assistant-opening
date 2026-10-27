export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "assistant" | "start" | "courses" | "review" | "library" | "sprint" | "cards" | "search";
  group: "core" | "tools";
};

/** The same three destinations own desktop, mobile and legacy entry routes. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "学习", icon: "start", group: "core" },
    { href: "/opening/review", label: "复习", icon: "review", group: "core" },
    { href: "/opening/library", label: "资料", icon: "library", group: "core" },
  ];
}

export function navigationIsActive(href: string, pathname: string, _search = ""): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  const path = pathname.split("?")[0] ?? pathname;
  const within = (owner: string) => path === owner || path.startsWith(`${owner}/`);
  if (["/opening/courses", "/opening/agent", "/opening/assistant", "/opening/sprint", "/opening/suggestions"].some(within)) return hrefPath === "/opening/today";
  if (within("/opening/cards")) return hrefPath === "/opening/review";
  if (within("/opening/search")) return hrefPath === "/opening/library";
  return within(hrefPath);
}
