"use client";

import type { ConnectionView } from "@aistudy/contracts";
import { connectionViewSchema } from "@aistudy/contracts";
import { LoaderCircle, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ui } from "../opening/design/ui";

const stateText: Record<ConnectionView["state"], string> = {
  disabled: "未启用",
  needs_authorization: "待组织授权",
  ready: "已授权",
  syncing: "同步中",
  error: "错误",
  revoked: "已撤销",
};

async function listConnections(): Promise<ConnectionView[]> {
  const response = await fetch("/api/opening/connections", { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : "连接列表暂时无法读取。";
    throw new Error(message);
  }
  return connectionViewSchema.array().parse(Array.isArray(body) ? body : body.connections);
}

function requestJson<T>(id: string, init: RequestInit): Promise<T> {
  return fetch(`/api/opening/connections/${encodeURIComponent(id)}/sync`, {
    ...init,
    headers: { "content-type": "application/json" },
  }).then(async response => {
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.error?.message === "string" ? body.error.message : "同步请求失败。";
      throw new Error(message);
    }
    return body as T;
  });
}

export function DingTalkConnectionsPanel() {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const views = await listConnections();
      if (!signal?.aborted) setConnections(views.filter(view => view.kind === "dingtalk"));
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "连接列表暂时无法读取。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function sync(view: ConnectionView) {
    if (busyId) return;
    setBusyId(view.id);
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ status: string; imported: number; skipped: number }>(
        view.id,
        { method: "POST", body: JSON.stringify({ clientKey: `ui-sync-${view.id}` }) },
      );
      setNotice(result.status === "needs_authorization"
        ? "钉钉组织尚未授权可读资源。"
        : result.status === "unsupported_history_read"
          ? "钉钉不支持历史群聊读取；回调事件会在组织授权后自动导入。"
          : `同步完成：导入 ${result.imported} 条，跳过 ${result.skipped} 条。`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "同步请求失败。");
    } finally {
      setBusyId(null);
    }
  }

  return <section aria-labelledby="dingtalk-connections-heading" className="grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
    <div>
      <h2 className="text-sm font-medium text-zinc-900" id="dingtalk-connections-heading">钉钉连接</h2>
      <p className="mt-1 text-xs leading-6 text-zinc-500">只处理组织授权的回调事件；不推断历史群聊读取权限。</p>
    </div>
    <div className="space-y-3">
      {error ? <p className="text-sm leading-6 text-red-700" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-zinc-500" role="status">正在读取连接…</p> : null}
      {!loading && connections.length === 0 ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm leading-6 text-zinc-600">
          还没有钉钉连接。组织管理员需要先创建企业内部应用并配置回调映射。
        </div>
      ) : null}
      {connections.map(view => (
        <div className="rounded-md border border-zinc-200 p-3" key={view.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900">{view.label}</p>
              <p className="mt-1 text-xs leading-6 text-zinc-500">
                {stateText[view.state]}
                {view.allowedScopes.length ? ` · ${view.allowedScopes.join("、")}` : " · 无已授权能力"}
              </p>
            </div>
            <button
              aria-label={`同步 ${view.label}`}
              className={ui.secondary}
              disabled={busyId === view.id || Boolean(busyId) || view.state === "revoked"}
              onClick={() => void sync(view)}
              type="button"
            >
              {busyId === view.id
                ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
                : <Send aria-hidden="true" size={14} />}
              同步
            </button>
          </div>
        </div>
      ))}
      <button className={ui.quiet} disabled={loading} onClick={() => void load()} type="button">
        <RefreshCw aria-hidden="true" size={14} />重新读取
      </button>
      {notice ? <p className="text-sm leading-6 text-emerald-700" role="status">{notice}</p> : null}
    </div>
  </section>;
}