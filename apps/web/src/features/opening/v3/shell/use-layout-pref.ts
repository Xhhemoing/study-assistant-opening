"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * 布局与外观偏好只存本地，不写 URL；手机不读取桌面宽度偏好。
 * skin / density / corner 写到 AppShell 根节点的 data-* 上，由 tailwind.css 外观层解释。
 */
export type Skin = "glass" | "paper";
export type Density = "compact" | "comfortable";
export type Corner = "round" | "crisp";
export type LayoutPref = { nav: "expanded" | "compact"; skin: Skin; density: Density; corner: Corner; side: "md" | "lg" };
const KEY = "aistudy.layout.v1";
const DEFAULT: LayoutPref = { nav: "expanded", skin: "glass", density: "compact", corner: "round", side: "md" };
const listeners = new Set<() => void>();
let cache: LayoutPref | null = null;

function read(): LayoutPref {
  if (cache) return cache;
  try { cache = { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutPref>) }; }
  catch { cache = DEFAULT; }
  return cache;
}

export function useLayoutPref() {
  const pref = useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    read,
    () => DEFAULT,
  );
  const update = useCallback((patch: Partial<LayoutPref>) => {
    cache = { ...read(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 隐私模式下仅本次有效 */ }
    listeners.forEach(cb => cb());
  }, []);
  return [pref, update] as const;
}
