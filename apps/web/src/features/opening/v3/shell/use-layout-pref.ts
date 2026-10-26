"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * 导航展开状态与工具分栏偏好只存本地，不写 URL。
 * 旧材质、密度、圆角与导航宽度读取时忽略，外观固定为当前默认值。
 */
export type Skin = "frost" | "glass" | "paper";
export type Density = "compact" | "comfortable";
export type Corner = "round" | "crisp";
/** 右侧分栏可放的内容 */
export type SplitPane = "assistant" | "notes" | "sources";
export type LayoutPref = {
  nav: "expanded" | "compact"; skin: Skin; density: Density; corner: Corner; side: "md" | "lg";
  /** 固定导航宽度；保留字段以兼容现有调用方。 */
  navWidth: number;
  /** 学习页右侧分栏：0–2 栏，按顺序从左到右 */
  split: SplitPane[];
  /** 分栏宽度：键为栏组合（如 "assistant+notes"），值为各面板 id → 百分比，由分栏组件写回 */
  splitLayouts: Record<string, Record<string, number>>;
};
export const NAV_WIDTH_DEFAULT = 208;
const KEY = "aistudy.layout.v1";
const DEFAULT: LayoutPref = { nav: "expanded", skin: "frost", density: "compact", corner: "round", side: "md", navWidth: NAV_WIDTH_DEFAULT, split: [], splitLayouts: {} };
const PANES: SplitPane[] = ["assistant", "notes", "sources"];

/** 本机存储可能被手改或来自旧版本：逐项校验，坏值回到默认 */
export function normalizeLayoutPref(raw: Partial<LayoutPref>): LayoutPref {
  const merged = { ...DEFAULT, ...raw };
  const split = Array.isArray(merged.split) ? merged.split.filter((pane, index, all) => PANES.includes(pane) && all.indexOf(pane) === index).slice(0, 2) : [];
  const layouts = merged.splitLayouts && typeof merged.splitLayouts === "object" ? merged.splitLayouts : {};
  const splitLayouts = Object.fromEntries(Object.entries(layouts).filter(([, layout]) => layout && typeof layout === "object"
    && Object.values(layout).every(size => typeof size === "number" && size > 0 && size <= 100)));
  return { ...DEFAULT, nav: merged.nav === "compact" ? "compact" : "expanded", split, splitLayouts };
}
const listeners = new Set<() => void>();
let cache: LayoutPref | null = null;

function read(): LayoutPref {
  if (cache) return cache;
  try { cache = normalizeLayoutPref(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutPref>); }
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
    cache = normalizeLayoutPref({ ...read(), ...patch });
    try { localStorage.setItem(KEY, JSON.stringify({ nav: cache.nav, split: cache.split, splitLayouts: cache.splitLayouts })); } catch { /* 隐私模式下仅本次有效 */ }
    listeners.forEach(cb => cb());
  }, []);
  return [pref, update] as const;
}
