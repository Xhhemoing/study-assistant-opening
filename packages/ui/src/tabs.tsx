"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { focusRing } from "./styles";

export const Tabs = TabsPrimitive.Root;
export const TabsList = forwardRef<ComponentRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(function TabsList({ className = "", children, ...props }, ref) {
  const list = useRef<HTMLDivElement | null>(null);
  const indicator = useRef<HTMLSpanElement | null>(null);
  const [indicatorReady, setIndicatorReady] = useState(false);
  useEffect(() => {
    const element = list.current, line = indicator.current;
    if (!element || !line || typeof line.animate !== "function") return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let previous: string | null = null;
    const observed = new Set<Element>();
    const update = (snap = false, force = false) => {
      const active = element.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!active) { animation?.cancel(); previous = null; setIndicatorReady(false); return; }
      const tabBounds = active.getBoundingClientRect(), listBounds = element.getBoundingClientRect();
      // Hidden panels have no geometry; retain the CSS underline until visible.
      if (!tabBounds.width) { animation?.cancel(); previous = null; setIndicatorReady(false); return; }
      const next = `translateX(${tabBounds.left - listBounds.left + element.scrollLeft}px) scaleX(${tabBounds.width})`;
      if (next === previous && !force) return;
      const current = getComputedStyle(line).transform;
      const from = current && current !== "none" ? current : previous ?? next;
      const immediate = snap || !previous || reduced?.matches || Boolean(element.closest('[data-motion="reduce"]'));
      animation?.cancel();
      animation = line.animate([{ transform: immediate ? next : from, opacity: 1 }, { transform: next, opacity: 1 }], {
        duration: immediate ? 0 : 220, easing: "cubic-bezier(.2, 0, 0, 1)", fill: "forwards",
      });
      previous = next; setIndicatorReady(true);
      element.querySelectorAll('[role="tab"]').forEach(tab => { if (!observed.has(tab)) { observed.add(tab); resize?.observe(tab); } });
      for (const tab of observed) if (!element.contains(tab)) { resize?.unobserve(tab); observed.delete(tab); }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update(true));
    resize?.observe(element);
    const selection = new MutationObserver(() => update());
    selection.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-state", "disabled", "dir"] });
    const preferenceChanged = () => update(true, true);
    const preference = new MutationObserver(preferenceChanged);
    preference.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    reduced?.addEventListener("change", preferenceChanged);
    window.addEventListener("resize", preferenceChanged);
    update(true);
    return () => { animation?.cancel(); selection.disconnect(); preference.disconnect(); resize?.disconnect(); reduced?.removeEventListener("change", preferenceChanged); window.removeEventListener("resize", preferenceChanged); };
  }, []);
  return <TabsPrimitive.List ref={node => { list.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node; }} data-indicator={indicatorReady ? "ready" : undefined} className={`group/tabs relative flex min-h-11 gap-1 overflow-x-auto border-b border-line ${className}`} {...props}>
    {children}<span ref={indicator} aria-hidden="true" data-tabs-indicator="true" className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left rounded-full bg-ink opacity-0" />
  </TabsPrimitive.List>;
});
export const TabsTrigger = forwardRef<ComponentRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(function TabsTrigger({ className = "", ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} className={`relative min-h-11 shrink-0 border-b-2 border-transparent px-4 text-sm text-text-2 hover:text-text data-[state=active]:font-medium data-[state=active]:text-text disabled:opacity-50 after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:origin-left after:scale-x-0 after:rounded-full after:bg-ink after:opacity-0 after:transition-[transform,opacity] after:duration-[220ms] after:ease-standard data-[state=active]:after:scale-x-100 data-[state=active]:after:opacity-100 group-data-[indicator=ready]/tabs:after:hidden motion-reduce:after:transition-none ${focusRing} ${className}`} {...props} />;
});
export const TabsContent = forwardRef<ComponentRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(function TabsContent({ className = "", ...props }, ref) {
  // forceMount callers retain state without exposing inactive controls to Tab/AT.
  return <TabsPrimitive.Content ref={ref} className={`min-w-0 py-4 data-[state=inactive]:hidden ${focusRing} ${className}`} {...props} />;
});
