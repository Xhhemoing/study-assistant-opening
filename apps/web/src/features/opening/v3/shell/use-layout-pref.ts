"use client";
import { useCallback, useSyncExternalStore } from "react";

/** 布局偏好只存本地，不写 URL；手机不读取桌面宽度偏好。 */
export type LayoutPref = { nav: "expanded" | "compact" };
const KEY = "aistudy.layout.v1";
const DEFAULT: LayoutPref = { nav: "expanded" };
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
