export interface CourseSummary {
  id: string;
  title: string;
  slug: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CourseAsset {
  id: string;
  assetType: string;
  assetId: string;
  role: string;
  sortOrder: number;
  document?: { id: string; title: string; updatedAt: string };
}

export function normalizeCourseSlug(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function coursePath(id: string): string {
  return `/learn/courses/${encodeURIComponent(id)}`;
}
