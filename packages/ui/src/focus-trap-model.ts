export type FocusDirection = "forward" | "backward";

export function getFocusTrapTarget(
  activeIndex: number,
  direction: FocusDirection,
  focusableCount: number,
): number | null {
  if (focusableCount < 1 || activeIndex < 0 || activeIndex >= focusableCount) return null;
  if (direction === "forward" && activeIndex === focusableCount - 1) return 0;
  if (direction === "backward" && activeIndex === 0) return focusableCount - 1;
  return null;
}
