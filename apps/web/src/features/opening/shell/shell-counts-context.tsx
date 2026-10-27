"use client";

import { createContext, useContext } from "react";

/** 壳层已读到的真实计数；页面复用而不重复请求。null 表示未知，不显示 0。 */
export type ShellCounts = { pendingSuggestions: number | null; dueReviews: number | null };

export const ShellCountsContext = createContext<ShellCounts>({ pendingSuggestions: null, dueReviews: null });

export function useShellCounts(): ShellCounts {
  return useContext(ShellCountsContext);
}
