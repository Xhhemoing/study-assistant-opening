"use client";

import type { ConnectionState, ConnectionView } from "@aistudy/contracts";

/** Exact copy for needs_authorization — e2e asserts 等待授权. */
export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  disabled: "已暂停",
  needs_authorization: "等待授权",
  ready: "已就绪",
  syncing: "同步中",
  error: "同步错误",
  revoked: "已撤销",
};

export function connectionStateLabel(state: ConnectionState): string {
  return CONNECTION_STATE_LABEL[state];
}

export function formatLastSyncAt(lastSuccessAt: string | null, timeZone = "Asia/Shanghai"): string {
  if (!lastSuccessAt) return "尚未成功同步";
  const at = new Date(lastSuccessAt);
  if (!Number.isFinite(at.getTime())) return "同步时间无效";
  return at.toLocaleString("zh-CN", { timeZone, hour12: false });
}

export function connectionErrorCopy(view: Pick<ConnectionView, "state" | "errorCode">): string | null {
  if (view.state !== "error") return null;
  return view.errorCode ? `错误：${view.errorCode}` : "同步出错，请检查授权后重试。";
}

export function isConnectionUnavailable(view: Pick<ConnectionView, "state">): boolean {
  return view.state === "revoked" || view.state === "disabled";
}

export function ConnectionStatusBadge({ view }: { view: ConnectionView }) {
  const label = connectionStateLabel(view.state);
  const tone =
    view.state === "ready"
      ? "bg-emerald-50 text-emerald-800"
      : view.state === "error" || view.state === "revoked"
        ? "bg-red-50 text-red-800"
        : view.state === "needs_authorization" || view.state === "disabled"
          ? "bg-amber-50 text-amber-900"
          : "bg-zinc-100 text-zinc-700";
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${tone}`} role="status">
      {label}
    </span>
  );
}

export function ConnectionStatusDetails({ view, timeZone }: { view: ConnectionView; timeZone?: string }) {
  const error = connectionErrorCopy(view);
  return (
    <div className="space-y-1 text-xs leading-5 text-zinc-600">
      <p>
        授权范围：{view.allowedScopes.length ? view.allowedScopes.join("、") : "尚无已授权能力"}
      </p>
      <p>最近同步：{formatLastSyncAt(view.lastSuccessAt, timeZone)}</p>
      {error ? <p className="text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}

/** Never echo mailbox secrets; clear after secure submit. */
export function shouldClearSecretAfterSubmit(ok: boolean): boolean {
  return ok;
}
