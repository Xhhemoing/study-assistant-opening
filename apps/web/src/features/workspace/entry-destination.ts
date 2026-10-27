/**
 * 默认入口（持久值 learn / explore / library，不改枚举）到根入口落点的白名单映射。
 * release：explore→助理、learn→学习、library→知识库，未设置→助理。
 * 非 release 保留旧工作区路径与旧的 null→learn。非法值返回 null，由调用方显示可重试错误，不拼接任意 URL。
 */
export type StoredDefaultEntry = "learn" | "explore" | "library";

const RELEASE: Record<StoredDefaultEntry, string> = {
  explore: "/opening/today",
  learn: "/opening/courses",
  library: "/opening/library",
};
const LEGACY: Record<StoredDefaultEntry, string> = {
  learn: "/learn",
  explore: "/explore",
  library: "/library",
};

export function entryDestination(value: unknown, release: boolean): string | null {
  if (value === null || value === undefined) return release ? RELEASE.explore : LEGACY.learn;
  if (value !== "learn" && value !== "explore" && value !== "library") return null;
  return (release ? RELEASE : LEGACY)[value];
}
