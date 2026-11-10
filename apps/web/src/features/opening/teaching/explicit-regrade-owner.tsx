"use client";

import { useEffect, useState } from "react";
import type { ExplicitRegradeRequest } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { createSessionFetch } from "../../auth/session-expiry";
import { createExplicitRegradeSession, type ExplicitRegradeOwner, type ExplicitRegradeSnapshot } from "./explicit-regrade-client";
import { createExplicitRegradeHttp, RegradeHttpError, type RegradeServerSnapshot } from "./explicit-regrade-http";
import { ExplicitRegradeControl } from "./explicit-regrade-control";
import { ui } from "../design/ui";

type Entry = { owner: ExplicitRegradeOwner | null; live: RegradeServerSnapshot | null; request?: ExplicitRegradeRequest;
  error: number | null; loading: boolean; epoch: number; load: () => Promise<void>; listeners: Set<() => void> };
type Tab = { namespace: string; entries: Map<string, Entry> };
const tabs = new WeakMap<Window, Tab>();

function currentTab(): Tab | null {
  const namespace = getVerifiedSessionNamespace();
  if (typeof window === "undefined") return null;
  if (!namespace) { tabs.delete(window); return null; }
  let tab = tabs.get(window);
  if (tab?.namespace !== namespace) { tab = { namespace, entries: new Map() }; tabs.set(window, tab); }
  return tab!;
}
function same(a: RegradeServerSnapshot, b: RegradeServerSnapshot) {
  return a.rootObservationId === b.rootObservationId && a.expectedHead === b.expectedHead && a.answerRevision === b.answerRevision
    && a.privacyEpoch === b.privacyEpoch && a.previousGradingVersion === b.previousGradingVersion;
}
function successor(live: RegradeServerSnapshot, base: ExplicitRegradeSnapshot, request?: ExplicitRegradeRequest) {
  return request?.state === "confirmed" && live.rootObservationId === base.rootObservationId
    && live.expectedHead === (request.resultObservationId ?? request.expectedHead) && live.answerRevision === base.answerRevision
    && live.privacyEpoch === base.privacyEpoch && live.previousGradingVersion === request.gradingVersion;
}

/** Tab-memory only. The authenticated namespace, live snapshot and epoch are checked at use time. */
function entryFor(tab: Tab, observationId: string): Entry {
  const cached = tab.entries.get(observationId);
  if (cached) return cached;
  const entry: Entry = { owner: null, live: null, error: null, loading: false, epoch: 0, listeners: new Set(), load: async () => undefined };
  const active = () => currentTab() === tab;
  const emit = () => entry.listeners.forEach(listener => listener());
  async function authorize() {
    if (!active()) throw new RegradeHttpError(403);
    // Recheck cookies too: another tab may have switched accounts since AuthGate mounted.
    const response = await createSessionFetch()("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new RegradeHttpError(response.status);
    const body: unknown = await response.json();
    const user = (body as { user?: { id?: string; workspaceId?: string } } | null)?.user;
    if (!active() || JSON.stringify([user?.id, user?.workspaceId]) !== tab.namespace) throw new RegradeHttpError(403);
  }
  function update(snapshot: RegradeServerSnapshot, request?: ExplicitRegradeRequest) {
    if (!active()) return;
    entry.live = snapshot;
    if (request) entry.request = request;
    const base = entry.owner?.operationSnapshot ?? entry.owner?.snapshot;
    const compatible = base && (same(snapshot, base) || successor(snapshot, base, entry.request));
    if (base && (!compatible || same(snapshot, base) && snapshot.oldStatus !== base.oldStatus && !request)) entry.epoch += 1;
    const next = base ? { ...base, oldStatus: snapshot.oldStatus, epoch: entry.epoch } : { ...snapshot, epoch: entry.epoch };
    entry.owner = { snapshot: { ...snapshot, epoch: entry.epoch }, operationSnapshot: next, session: entry.owner?.session ?? session };
    emit();
  }
  const http = createExplicitRegradeHttp(update, authorize);
  const writable = () => entry.live?.oldStatus === "unknown_cost" && Boolean(entry.owner && same(entry.live, entry.owner.operationSnapshot ?? entry.owner.snapshot));
  const adapter: typeof http.adapter = {
    prepare: input => writable() ? checked(() => http.adapter.prepare(input)) : Promise.resolve({ kind: "conflict" }),
    confirm: input => writable() ? checked(() => http.adapter.confirm(input)) : Promise.resolve({ kind: "conflict" }),
    read: input => checked(() => http.adapter.read(input)),
  };
  async function checked<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (active() && error instanceof RegradeHttpError && [401, 403, 404].includes(error.status)) { entry.error = error.status; emit(); }
      throw error;
    }
  }
  const session = createExplicitRegradeSession(adapter, snapshot => {
    const current = entry.owner?.operationSnapshot ?? entry.owner?.snapshot;
    return active() && !entry.loading && entry.error === null && Boolean(current && current.epoch === snapshot.epoch
      && same(current, snapshot) && (current.oldStatus === snapshot.oldStatus
        || Boolean(entry.live && successor(entry.live, snapshot, entry.request))));
  });
  entry.load = async () => {
    if (entry.loading || !active()) return;
    entry.loading = true; entry.error = null; emit();
    try { update(await http.snapshot(observationId)); }
    catch (error) { if (active()) entry.error = error instanceof RegradeHttpError ? error.status : 0; }
    finally { entry.loading = false; emit(); }
  };
  tab.entries.set(observationId, entry);
  return entry;
}

export function ExplicitRegradeHttpOwner({ observationId, disabled = false }: { observationId: string; disabled?: boolean }) {
  const [, render] = useState(0);
  const tab = currentTab();
  const entry = tab ? entryFor(tab, observationId) : null;
  useEffect(() => {
    if (!entry) return;
    const listener = () => render(value => value + 1);
    entry.listeners.add(listener);
    void entry.load(); // Initial/remount reads do not create, confirm or enqueue anything.
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  if (!entry) return null;
  return <>
    {entry.owner ? <ExplicitRegradeControl owner={entry.owner} disabled={disabled || entry.loading || entry.error !== null} /> : null}
    {entry.loading ? <p role="status" className="text-xs text-text-2">正在读取当前评改版本（不调用 AI）…</p> : null}
    {entry.error !== null ? <div className="space-y-2">
      <p role="alert" className="text-xs text-danger">{entry.error === 401 ? "登录已失效，请先验证原账户；不会自动重发收费请求。"
        : entry.error === 403 ? "账户或权限已变化，请切回原账户和学习空间；不会自动新建收费请求。"
          : entry.error === 409 || entry.error === 404 ? "当前作答或隐私状态已变化，请重新读取学习记录；不会自动新建收费请求。"
            : "当前评改版本暂时无法读取；原答案与历史保留，不会自动重发。"}</p>
      <button type="button" className={ui.secondary} disabled={disabled || entry.loading} onClick={() => void entry.load()}>重新读取当前评改版本（不调用 AI）</button>
    </div> : null}
  </>;
}
