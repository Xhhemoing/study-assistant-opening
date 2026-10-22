"use client";
import { createContext, useContext, type ReactNode } from "react";

/**
 * 页头右侧的手机工具（搜索 + 更多）由壳层注入。
 * 页面只依赖这个轻量模块，不必导入整个壳层（导航、抽屉、图标），独立渲染/测试时为空。
 */
export const HeaderToolsSlot = createContext<ReactNode>(null);

export function ShellHeaderTools() {
  return <>{useContext(HeaderToolsSlot)}</>;
}
