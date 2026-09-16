export type OpeningNavigationItem = {
  href: "/opening/today" | "/opening/assistant" | "/opening/courses";
  label: string;
};

/** Returns the three stable entry points for the opening experience. */
export function openingNavigation(): OpeningNavigationItem[] {
  return [
    { href: "/opening/today", label: "今日" },
    { href: "/opening/assistant", label: "助理" },
    { href: "/opening/courses", label: "课程" },
  ];
}
