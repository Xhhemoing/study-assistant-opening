"use client";

import { useEffect, type RefObject } from "react";

const anchors = new Set(["export", "developer", "quick-model-setup", "daily-budget"]);

/** Legacy bookmarks may target closed or asynchronously loaded AI settings. */
export function useSettingsAnchorReveal(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let observer: MutationObserver | null = null;
    function reveal() {
      const id = window.location.hash.slice(1);
      if (!anchors.has(id)) return true;
      const target = document.getElementById(id);
      const root = container.current;
      if (!target || !root?.contains(target)) return false;
      for (let element: HTMLElement | null = target; element && root.contains(element); element = element.parentElement) {
        if (element instanceof HTMLDetailsElement) element.open = true;
      }
      target.scrollIntoView({ block: "start" });
      return true;
    }
    function followHash() {
      observer?.disconnect(); observer = null;
      if (reveal() || !container.current) return;
      observer = new MutationObserver(() => {
        if (reveal()) { observer?.disconnect(); observer = null; }
      });
      observer.observe(container.current, { childList: true, subtree: true });
    }
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => { observer?.disconnect(); window.removeEventListener("hashchange", followHash); };
  }, [container]);
}
