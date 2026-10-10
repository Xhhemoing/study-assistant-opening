"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { FolderInput, Plus, Upload, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi } from "../opening/client/api";
import { LoadError, ui } from "../opening/design/ui";
import { createMaterialOrganizationClient, type OrganizationResult } from "../opening/library/material-organization-client";
import type { CourseAsset } from "./course-model";

export type MaterialRole = "core" | "optional" | "reference";

function sourceAlreadyOnCourse(sourceId: string, assets: CourseAsset[]): boolean {
  return assets.some((asset) => asset.assetType === "source" && (asset.assetId === sourceId || asset.source?.id === sourceId));
}

export function availableSourcesForCourse(sources: SourceRecord[], assets: CourseAsset[]): SourceRecord[] {
  return sources.filter((source) => !sourceAlreadyOnCourse(source.id, assets));
}

export function CourseAddMaterials({
  courseId,
  assets,
  onAdded,
}: {
  courseId: string;
  assets: CourseAsset[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<MaterialRole>("reference");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OrganizationResult | null>(null);
  const [actionError, setActionError] = useState("");

  const available = useMemo(() => availableSourcesForCourse(sources, assets), [sources, assets]);
  const uploaded = useMemo(() => available.filter((source) => source.uploadState === "uploaded"), [available]);
  const pending = useMemo(() => available.filter((source) => source.uploadState !== "uploaded"), [available]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await createOpeningApi().listSources();
      setSources(rows);
    } catch {
      setLoadError("知识库材料暂时无法读取，请重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setRole("reference");
    setResult(null);
    setActionError("");
    void load();
  }, [open, load]);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function confirm() {
    if (!selected.length || busy) return;
    setBusy(true);
    setActionError("");
    setResult(null);
    try {
      const next = await createMaterialOrganizationClient().addToCourse(courseId, selected, role);
      setResult(next);
      setSelected(next.failed.map((item) => item.id));
      if (next.succeeded.length) onAdded();
      if (!next.failed.length) setOpen(false);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "挂接失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ui.secondary} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <Plus size={14} aria-hidden="true" />添加材料
        </button>
        <Link
          className={ui.quiet}
          href={`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}#upload`}
        >
          <Upload size={14} aria-hidden="true" />上传并归入本课
        </Link>
      </div>
      {open ? (
        <section aria-label="添加材料到课程" className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-600">从知识库选择尚未挂入本课的材料。</p>
            <button type="button" className={ui.icon} aria-label="关闭添加材料" title="关闭" onClick={() => setOpen(false)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {loading ? <p className="text-xs text-zinc-500" role="status">正在读取知识库…</p> : null}
          {loadError ? <LoadError message={loadError} onRetry={() => void load()} /> : null}
          {!loading && !loadError && !available.length ? (
            <p className="text-xs text-zinc-500">知识库里没有可挂入的新材料。可先去材料库上传，或确认材料尚未挂入本课。</p>
          ) : null}
          {!loading && uploaded.length ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2">
              {uploaded.map((source) => (
                <li key={source.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-800 hover:bg-zinc-50">
                    <input
                      type="checkbox"
                      className="size-4 accent-emerald-700"
                      checked={selected.includes(source.id)}
                      disabled={busy}
                      onChange={() => toggle(source.id)}
                      aria-label={`选择材料 ${source.name}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{source.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {!loading && pending.length ? (
            <div className="space-y-1">
              <p className="text-[11px] text-zinc-500">以下材料尚未完成上传，暂不可选：</p>
              <ul className="space-y-1 text-xs text-zinc-400">
                {pending.map((source) => (
                  <li key={source.id} className="truncate px-2 py-1">{source.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <label>
              <span className="sr-only">材料用途</span>
              <select
                aria-label="材料用途"
                className={`${ui.input} w-32`}
                disabled={busy}
                value={role}
                onChange={(event) => setRole(event.target.value as MaterialRole)}
              >
                <option value="reference">参考资料</option>
                <option value="core">核心教材</option>
                <option value="optional">拓展阅读</option>
              </select>
            </label>
            <button type="button" className={ui.primary} disabled={busy || !selected.length} onClick={() => void confirm()}>
              <FolderInput size={14} aria-hidden="true" />
              {busy ? "正在挂接…" : `确认挂接${selected.length ? `（${selected.length}）` : ""}`}
            </button>
          </div>
          {result ? (
            <div role="status" className="space-y-1 text-xs text-zinc-700">
              <p>
                {result.succeeded.length} 份挂接成功
                {result.failed.length ? `，${result.failed.length} 份未完成` : ""}。
              </p>
              {result.failed.map((item) => (
                <p key={item.id} className="break-words text-red-700">
                  {sources.find((source) => source.id === item.id)?.name ?? item.id}：{item.message}
                </p>
              ))}
            </div>
          ) : null}
          {actionError ? <LoadError message={actionError} /> : null}
        </section>
      ) : null}
    </div>
  );
}
