export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "assistant" | "start" | "courses" | "review" | "library" | "sprint" | "cards" | "search";
  group: "core" | "tools";
};

/** The same three destinations own desktop, mobile and legacy entry routes. */
type OpeningNavigationOptions = { studySessionV2?: boolean };

export function openingNavigation({ studySessionV2 = false }: OpeningNavigationOptions = {}): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: studySessionV2 ? "今日" : "学习", icon: "start", group: "core" },
    studySessionV2
      ? { href: "/opening/courses", label: "课程", icon: "courses", group: "core" }
      : { href: "/opening/review", label: "复习", icon: "review", group: "core" },
    { href: "/opening/library", label: "资料", icon: "library", group: "core" },
  ];
}

export function navigationIsActive(href: string, pathname: string, _search = "", { studySessionV2 = false }: OpeningNavigationOptions = {}): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  const path = pathname.split("?")[0] ?? pathname;
  const within = (owner: string) => path === owner || path.startsWith(`${owner}/`);
  if (within("/opening/courses")) return hrefPath === (studySessionV2 ? "/opening/courses" : "/opening/today");
  if (["/opening/agent", "/opening/assistant", "/opening/sprint", "/opening/suggestions"].some(within)) return hrefPath === "/opening/today";
  if (within("/opening/cards") || (studySessionV2 && within("/opening/review"))) return hrefPath === (studySessionV2 ? "/opening/today" : "/opening/review");
  if (within("/opening/search")) return hrefPath === "/opening/library";
  return within(hrefPath);
}
