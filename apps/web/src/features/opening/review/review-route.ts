export const reviewTabs = [
  { id: "all", label: "全部" },
  { id: "cards", label: "记忆卡片" },
  { id: "retests", label: "待复测" },
  { id: "reinforcement", label: "补强练习" },
] as const;
export type ReviewTab = typeof reviewTabs[number]["id"];
export type ReviewSearch = Record<string, string | string[] | undefined>;

export function readReviewTab(value: string | string[] | undefined): ReviewTab {
  return reviewTabs.some(tab => tab.id === value) ? value as ReviewTab : "all";
}

export function reviewTabHref(tab: ReviewTab, search = ""): string {
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return `/opening/review?${params}`;
}

export function legacyCardsHref(search: ReviewSearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  return reviewTabHref("cards", params.toString());
}
