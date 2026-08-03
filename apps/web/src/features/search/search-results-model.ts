import type { SearchHit } from "@aistudy/domain";

export const SEARCH_RESULT_TYPES: SearchHit["type"][] = [
  "document",
  "exploration",
  "card",
  "course",
  "practice",
];

const SEARCH_RESULT_LABELS: Record<SearchHit["type"], string> = {
  document: "笔记",
  exploration: "探索",
  card: "卡片",
  course: "课程",
  practice: "练习",
};

export interface SearchResultGroup {
  type: SearchHit["type"];
  label: string;
  hits: SearchHit[];
}

export function searchHitTypeLabel(type: SearchHit["type"]): string {
  return SEARCH_RESULT_LABELS[type];
}

export function groupSearchHits(hits: SearchHit[]): SearchResultGroup[] {
  return SEARCH_RESULT_TYPES.flatMap((type) => {
    const matchingHits = hits.filter((hit) => hit.type === type);
    return matchingHits.length > 0
      ? [{ type, label: searchHitTypeLabel(type), hits: matchingHits }]
      : [];
  });
}

export function searchHitHref(hit: SearchHit): string {
  const id = encodeURIComponent(hit.id);
  if (hit.type === "document") return `/library/${id}`;
  if (hit.type === "exploration") return `/explore/${id}`;
  if (hit.type === "card") return `/learn/review?cardId=${id}`;
  if (hit.type === "course") return `/learn/courses/${id}`;
  return `/learn/practice/${id}`;
}
