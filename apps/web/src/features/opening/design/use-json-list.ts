"use client";
import { useCallback, useEffect, useState } from "react";

export function useJsonList<T>(url: string, key: string, isRow: (value: unknown) => value is T) {
  const [rows, setRows] = useState<T[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? "登录状态已过期，请重新登录。" : "暂时无法读取内容，请重试。");
        const body: unknown = await response.json();
        const list = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
        if (!Array.isArray(list) || !list.every(isRow)) throw new Error("服务器返回的数据格式不完整，请重试。");
        if (!controller.signal.aborted) setRows(list);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "读取失败");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [url, key, isRow, retry]);
  const reload = useCallback(() => setRetry(value => value + 1), []);
  return { rows, loading, error, reload };
}
export function hasStringFields<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, string> {
  return !!value && typeof value === "object" && keys.every(key => typeof (value as Record<string, unknown>)[key] === "string");
}
export function displayDate(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "时间未记录";
}
