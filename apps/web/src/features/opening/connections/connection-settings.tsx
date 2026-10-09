"use client";

import type { ConnectionView, ImapSetupInput } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import {
  ConnectionStatusBadge,
  ConnectionStatusDetails,
  connectionStateLabel,
  isConnectionUnavailable,
  shouldClearSecretAfterSubmit,
} from "./connection-status";

function mintKey(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}`;
}

const emptyImap = {
  label: "", host: "", port: "993", tlsMode: "implicit" as const, username: "", folders: "INBOX", sinceDays: "14",
};

export function ConnectionSettings({ api: supplied }: { api?: OpeningApi }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [rows, setRows] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  const [imap, setImap] = useState(emptyImap);
  const [secret, setSecret] = useState("");
  const [secretForId, setSecretForId] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setRows(await api.listConnections()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "连接列表暂时无法读取"); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function createImap() {
    setBusyId("create"); setError(""); setNotice("");
    try {
      const since = new Date();
      since.setDate(since.getDate() - Math.max(1, Number(imap.sinceDays) || 14));
      const input: ImapSetupInput = {
        label: imap.label.trim(), host: imap.host.trim(), port: Number(imap.port) || 993,
        tlsMode: imap.tlsMode, username: imap.username.trim(),
        folders: imap.folders.split(",").map((f) => f.trim()).filter(Boolean),
        since: since.toISOString(), clientKey: mintKey("imap-create"),
      };
      await api.createImapConnection(input);
      setImap(emptyImap); setNotice("已创建邮箱连接（尚未授权，不代表已自动同步）。"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建连接失败"); }
    finally { setBusyId(null); }
  }

  async function submitSecret(view: ConnectionView) {
    if (!secret.trim() || busyId) return;
    setBusyId(view.id); setError(""); setNotice("");
    try {
      await api.putConnectionCredential(view.id, { secret, clientKey: mintKey("cred") });
      if (shouldClearSecretAfterSubmit(true)) { setSecret(""); setSecretForId(null); }
      setNotice("凭据已安全提交，表单已清空；页面不会回显邮箱密码。"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "凭据提交失败"); }
    finally { setBusyId(null); }
  }

  async function sync(view: ConnectionView) {
    if (busyId || pausedIds.has(view.id) || isConnectionUnavailable(view)) return;
    setBusyId(view.id); setError(""); setNotice("");
    try {
      await api.syncConnection(view.id, { clientKey: mintKey("sync") });
      setNotice("已排队同步。"); await load();
    } catch (reason) {
      setError(reason instanceof OpeningApiError ? reason.message : reason instanceof Error ? reason.message : "同步失败");
    } finally { setBusyId(null); }
  }

  function pause(view: ConnectionView) {
    setPausedIds((prev) => new Set(prev).add(view.id));
    setNotice(`${view.label} 已在本页暂停同步请求；服务端状态仍为「${connectionStateLabel(view.state)}」。`);
  }

  async function revoke(view: ConnectionView) {
    if (busyId || view.state === "revoked") return;
    setBusyId(view.id); setError(""); setNotice("");
    try {
      await api.revokeConnection(view.id, { expectedVersion: view.version, clientKey: mintKey("revoke") });
      setNotice("连接已撤销，凭据已删除。"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "撤销失败"); }
    finally { setBusyId(null); }
  }

  async function importManual(file: File | null) {
    if (!file || manualBusy) return;
    setManualBusy(true); setError(""); setNotice("");
    try {
      await api.importEmailManual(file);
      setNotice("手工导入已完成（标记为手工，不是自动邮箱同步）。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "手工导入失败"); }
    finally { setManualBusy(false); }
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700" role="status">{notice}</p> : null}
      {loading ? <p className="text-sm text-zinc-500" role="status">正在读取连接…</p> : null}
      <ul className="space-y-3" aria-label="数据连接">
        {rows.map((view) => {
          const paused = pausedIds.has(view.id) || view.state === "disabled";
          return (
            <li key={view.id} className="rounded-lg border border-zinc-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-900">{view.label}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{view.kind === "imap" ? "学校邮箱" : "钉钉"}</p>
                </div>
                <ConnectionStatusBadge view={view} />
              </div>
              <div className="mt-2"><ConnectionStatusDetails view={view} /></div>
              {paused ? <p className="mt-2 text-xs text-amber-900" role="status">已暂停</p> : null}
              {secretForId === view.id ? (
                <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void submitSecret(view); }}>
                  <label className="block text-xs text-zinc-600">邮箱密码 / 应用专用密码
                    <input type="password" autoComplete="new-password" className={`${inputClass} mt-1`} value={secret} onChange={(e) => setSecret(e.target.value)} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className={buttonClass} disabled={busyId != null || !secret.trim()}>安全提交</button>
                    <button type="button" className={secondaryButtonClass} onClick={() => { setSecret(""); setSecretForId(null); }}>取消</button>
                  </div>
                </form>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {view.kind === "imap" && view.state === "needs_authorization" ? (
                  <button type="button" className={secondaryButtonClass} disabled={busyId != null} onClick={() => { setSecretForId(view.id); setSecret(""); }}>填写凭据</button>
                ) : null}
                <button type="button" className={secondaryButtonClass} disabled={busyId != null || paused || isConnectionUnavailable(view)} onClick={() => void sync(view)}>同步</button>
                <button type="button" className={secondaryButtonClass} disabled={busyId != null || paused || view.state === "revoked"} onClick={() => pause(view)}>暂停</button>
                <button type="button" className={secondaryButtonClass} disabled={busyId != null || view.state === "revoked"} onClick={() => void revoke(view)}>撤销</button>
              </div>
            </li>
          );
        })}
      </ul>
      {!loading && rows.length === 0 ? <p className="text-sm text-zinc-600">还没有连接。未配置的服务显示为不可用，不会填充示例内容。</p> : null}

      <section className="space-y-3 border-t border-zinc-200 pt-4" aria-labelledby="imap-create-heading">
        <h2 className="text-sm font-semibold text-zinc-900" id="imap-create-heading">添加学校邮箱</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ["label", "显示名称", "text"], ["host", "IMAP 主机", "text"], ["port", "端口", "text"],
            ["username", "用户名", "text"], ["folders", "文件夹（逗号分隔）", "text"], ["sinceDays", "回溯天数", "text"],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-xs text-zinc-600">{label}
              <input className={`${inputClass} mt-1`} value={imap[key]} onChange={(e) => setImap((c) => ({ ...c, [key]: e.target.value }))} />
            </label>
          ))}
        </div>
        <button type="button" className={buttonClass} disabled={busyId != null} onClick={() => void createImap()}>创建连接</button>
      </section>

      <section className="space-y-2 border-t border-zinc-200 pt-4" aria-labelledby="manual-import-heading">
        <h2 className="text-sm font-semibold text-zinc-900" id="manual-import-heading">手工导入邮件</h2>
        <p className="text-xs leading-5 text-zinc-500">此路径明确标记为<strong>手工</strong>，不会伪装成自动邮箱同步。</p>
        <input type="file" accept=".eml,message/rfc822" aria-label="选择 .eml 文件手工导入" disabled={manualBusy}
          onChange={(e) => void importManual(e.target.files?.[0] ?? null)} />
      </section>
      <button type="button" className={secondaryButtonClass} disabled={loading} onClick={() => void load()}>重新读取</button>
    </div>
  );
}
