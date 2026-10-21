import type { ReviewGrade } from "@aistudy/contracts";

export type CardShortcut = { kind: "flip" } | { kind: "grade"; grade: ReviewGrade };

export function resolveCardShortcut(event: { key: string; keyCode?: number; isComposing?: boolean; repeat?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }, state: { flipped: boolean; disabled: boolean; blocked?: boolean }): CardShortcut | null {
  if (state.disabled || state.blocked || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === " ") return { kind: "flip" };
  if (!state.flipped) return null;
  const grades: Record<string, ReviewGrade> = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
  const grade = grades[event.key];
  return grade ? { kind: "grade", grade } : null;
}

export function cardKeyboardBlocked(element: HTMLElement, target: EventTarget | null): boolean {
  const document = element.ownerDocument;
  if (!document.contains(element) || element.closest("[hidden], [inert]")) return true;
  const dialog = document.querySelector('dialog[open], [role="dialog"][data-state="open"]');
  if (dialog && !dialog.contains(element)) return true;
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'));
}
