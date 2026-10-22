export type OpeningNavigationItem = {
  href: string;
  label: string;
  icon: "start" | "courses" | "review" | "library" | "sprint" | "cards" | "search";
  group: "core" | "tools";
};

/** One source for the four primary destinations and their stable tool entries. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "开始", icon: "start", group: "core" },
    { href: "/opening/courses", label: "课程", icon: "courses", group: "core" },
    { href: "/opening/review", label: "复习", icon: "review", group: "core" },
    { href: "/opening/library", label: "资料", icon: "library", group: "core" },
    { href: "/opening/sprint", label: "冲刺", icon: "sprint", group: "tools" },
    { href: "/opening/cards", label: "卡组", icon: "cards", group: "tools" },
    { href: "/opening/search", label: "搜索", icon: "search", group: "tools" },
  ];
}

export function navigationIsActive(href: string, pathname: string, search = ""): boolean {
  const hrefPath = href.split("?")[0] ?? href;
  const path = pathname.split("?")[0] ?? pathname;
  const params = new URLSearchParams(search || pathname.split("?")[1] || "");
  // Legacy entries intentionally redirect into these shared pages. Their selected
  // section still belongs to the original tool, with exactly one active owner.
  const section = path === "/opening/review" && params.getAll("tab").length === 1 && params.get("tab") === "cards" ? "/opening/cards"
    : /^\/opening\/courses\/[^/]+\/?$/.test(path) && params.getAll("mode").length === 1 && params.get("mode") === "sprint" ? "/opening/sprint" : null;
  if (section) return hrefPath === section;
  if (hrefPath === "/opening/today" && ["/opening/assistant", "/opening/suggestions"].some(owner => path === owner || path.startsWith(`${owner}/`))) return true;
  return path === hrefPath || path.startsWith(`${hrefPath}/`);
}
