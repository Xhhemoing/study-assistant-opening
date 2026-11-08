/** Minimal projection shared by server readers and browser course entry. */
export type CurrentLearningActivity = {
  id: string; courseId: string | null; status: string; updatedAt: string;
  /** Static lessons have persisted session content rather than compiled blocks. */
  placeholder: boolean;
};
export function compareCurrentLearningActivities(a: Pick<CurrentLearningActivity, "updatedAt" | "id">, b: Pick<CurrentLearningActivity, "updatedAt" | "id">): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id.localeCompare(a.id);
}
/** All explicit identities must agree. An unavailable identity never becomes a latest lookup. */
export function selectCurrentLearningActivity<T extends CurrentLearningActivity>(rows: readonly T[], courseId: string,
  references: readonly string[] = []): T | null {
  const explicit = [...new Set(references)];
  if (explicit.length > 1) return null;
  return rows.filter(row => row.courseId === courseId && !row.placeholder && ["active", "paused"].includes(row.status)
    && (!explicit.length || row.id === explicit[0])).sort(compareCurrentLearningActivities)[0] ?? null;
}
