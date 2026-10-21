"use client";

import { useEffect, useRef, type RefObject } from "react";

type ArrowEvent = Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing" | "keyCode" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;
type ArrowGuard = { editing: boolean; selection: boolean; hidden: boolean; modal: boolean; withinLesson: boolean; busy: boolean; previous: boolean; next: boolean };

export function lessonArrowDirection(event: ArrowEvent, guard: ArrowGuard): -1 | 1 | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || guard.editing || guard.selection || guard.hidden || guard.modal || !guard.withinLesson || guard.busy) return null;
  return event.key === "ArrowLeft" && guard.previous ? -1 : event.key === "ArrowRight" && guard.next ? 1 : null;
}

/** Share the visible buttons' callbacks; arrow keys never bypass their answer or save gates. */
export function useLessonArrowKeys(root: RefObject<HTMLElement | null>, actions: { previous?: () => void; next?: () => void; busy?: () => boolean }) {
  const current = useRef(actions);
  current.current = actions;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const element = root.current;
      if (!element) return;
      const target = event.target instanceof Element ? event.target : null;
      const visible = (node: Element) => node.getClientRects().length > 0 && !node.closest("[hidden],[inert]");
      const direction = lessonArrowDirection(event, {
        editing: Boolean(target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="tablist"],[role="menu"],[role="listbox"],[data-lesson-shortcuts-ignore]')),
        selection: window.getSelection()?.isCollapsed === false,
        hidden: document.visibilityState === "hidden" || !visible(element),
        modal: [...document.querySelectorAll('dialog[open],[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')].some(visible),
        withinLesson: Boolean(target && (element.contains(target) || (target === document.body && [...document.querySelectorAll('[data-lesson-shortcuts="true"]')].filter(visible).length === 1))),
        busy: current.current.busy?.() ?? false,
        previous: Boolean(current.current.previous), next: Boolean(current.current.next),
      });
      if (direction === null) return;
      event.preventDefault();
      (direction === -1 ? current.current.previous : current.current.next)?.();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [root]);
}
