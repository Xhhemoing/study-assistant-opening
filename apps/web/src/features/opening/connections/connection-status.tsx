"use client";

import type { ConnectionState, ConnectionView } from "@aistudy/contracts";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";

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

export function connectionErrorCopy(view: Pick<ConnectionView, "state" | "errorCode">, diagnostics = false): string | null {
  if (view.state !== "error") return null;
  return `同步出错，请检查授权后重试。${diagnostics && view.errorCode ? ` 错误代码：${view.errorCode}` : ""}`;
}

export function isConnectionUnavailable(view: Pick<ConnectionView, "state">): boolean {
  return view.state === "revoked" || view.state === "disabled";
}

export function ConnectionStatusBadge({ view }: { view: ConnectionView }) {
  const label = connectionStateLabel(view.state);
  const tone =
    view.state === "ready"
      ? "bg-accent-soft text-accent"
      : view.state === "error" || view.state === "revoked"
        ? "bg-danger/10 text-danger"
        : view.state === "needs_authorization" || view.state === "disabled"
          ? "bg-warn-soft text-warn"
          : "bg-surface-2 text-text-2";
  return (
    <span className={`inline-flex min-h-6 items-center rounded-full px-2 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

export function ConnectionStatusDetails({ view, timeZone }: { view: ConnectionView; timeZone?: string }) {
  const error = connectionErrorCopy(view, useDiagnosticsEnabled());
  return (
    <div className="space-y-1 text-xs leading-5 text-text-2">
      <p>
        授权范围：{view.allowedScopes.length ? view.allowedScopes.join("、") : "尚无已授权能力"}
      </p>
      <p>最近同步：{formatLastSyncAt(view.lastSuccessAt, timeZone)}</p>
      {error ? <p className="text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

/** Never echo mailbox secrets; clear after secure submit. */
export function shouldClearSecretAfterSubmit(ok: boolean): boolean {
  return ok;
}
