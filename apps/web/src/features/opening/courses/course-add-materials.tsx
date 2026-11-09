"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { FolderInput, Plus, Upload, X } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createOpeningApi } from "../client/api";
import { LoadError, ui } from "../design/ui";
import type { OrganizationResult } from "../library/material-organization-client";
import { createCourseSourcePurposeClient, CourseSourcePurposeError, SOURCE_PURPOSE_HELP, SOURCE_PURPOSE_SCOPE, type CourseSourcePurpose } from "./course-source-purpose-client";
import { CourseSourcePurposeSelect } from "./course-source-purpose-control";
import type { CourseAsset } from "./course-model";
import { userFacingMessage } from "../../../lib/user-facing-error";

export type MaterialRole = "core" | "optional" | "reference";

function sourceAlreadyOnCourse(sourceId: string, assets: CourseAsset[]): boolean {
  return assets.some((asset) => asset.assetType === "source" && (asset.assetId === sourceId || asset.source?.id === sourceId));
}

export function availableSourcesForCourse(sources: SourceRecord[], assets: CourseAsset[]): SourceRecord[] {
  return sources.filter((source) => !sourceAlreadyOnCourse(source.id, assets));
}

export function CourseAddMaterials(props: { courseId: string; assets: CourseAsset[]; onAdded: () => void }) {
  return <AddMaterials key={props.courseId} {...props} />;
}

function AddMaterials({
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
  const [purpose, setPurpose] = useState<CourseSourcePurpose>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const addedSinceRefresh = useRef(false);
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const active = useRef(true);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [result, setResult] = useState<OrganizationResult | null>(null);
  const [actionError, setActionError] = useState("");

  const available = useMemo(() => availableSourcesForCourse(sources, assets).filter(row => !addedIds.includes(row.id)), [sources, assets, addedIds]);
  const uploaded = useMemo(() => available.filter((source) => source.uploadState === "uploaded"), [available]);
  const pending = useMemo(() => available.filter((source) => source.uploadState !== "uploaded"), [available]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await createOpeningApi().listSources();
      if (active.current) setSources(rows);
    } catch {
      if (active.current) setLoadError("知识库材料暂时无法读取，请重试。");
    } finally {
      if (active.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setRole("reference");
    setPurpose(null);
    setResult(null);
    setActionError("");
    void load();
  }, [open, load]);

  function close() {
    setOpen(false);
    if (addedSinceRefresh.current || needsRefresh) onAdded();
  }

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function confirm() {
    if (!selected.length || inFlight.current || needsRefresh) return;
    inFlight.current = true;
    setBusy(true);
    setActionError("");
    setResult(null);
    try {
      const next: OrganizationResult = { succeeded: [], failed: [] };
      const client = createCourseSourcePurposeClient();
      for (const sourceId of selected) {
        if (!active.current) break;
        try {
          await client.add(courseId, sourceId, role, purpose);
          next.succeeded.push(sourceId);
        } catch (reason) {
          next.failed.push({ id: sourceId, message: reason instanceof CourseSourcePurposeError ? reason.message : "挂接结果尚未确认，请刷新核对后再操作。" });
          // Permission/conflict/unknown outcomes must not be retried or hidden as success.
          if (active.current) setNeedsRefresh(true);
          for (const id of selected.slice(selected.indexOf(sourceId) + 1)) next.failed.push({ id, message: "尚未提交，请刷新核对后再操作。" });
          break;
        }
      }
      if (!active.current) return;
      setResult(next);
      setSelected(next.failed.map((item) => item.id));
      if (next.succeeded.length) {
        addedSinceRefresh.current = true;
        setAddedIds(ids => [...ids, ...next.succeeded]);
      }
      // Keep partial failures visible until dismissed; a parent reload unmounts this panel.
      if (!next.failed.length) { setOpen(false); onAdded(); }
    } catch (reason) {
      setActionError(userFacingMessage(reason, "挂接失败，请重试。"));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={ui.secondary} disabled={busy} onClick={() => open ? close() : setOpen(true)} aria-expanded={open}>
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
        <section aria-label="添加材料到课程" className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-text-2">从知识库选择尚未挂入本课的材料。</p>
            <button type="button" className={ui.icon} aria-label="关闭添加材料" title="关闭" disabled={busy} onClick={close}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {loading ? <p className="text-xs text-text-3" role="status">正在读取知识库…</p> : null}
          {loadError ? <LoadError message={loadError} onRetry={() => void load()} /> : null}
          {!loading && !loadError && !available.length ? (
            <p className="text-xs text-text-3">知识库里没有可挂入的新材料。可先去材料库上传，或确认材料尚未挂入本课。</p>
          ) : null}
          {!loading && uploaded.length ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-2">
              {uploaded.map((source) => (
                <li key={source.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs text-text hover:bg-surface-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
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
              <p className="text-xs text-text-3">以下材料尚未完成上传，暂不可选：</p>
              <ul className="space-y-1 text-xs text-text-3">
                {pending.map((source) => (
                  <li key={source.id} className="truncate px-2 py-1">{source.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <label>
              <span className="mb-1 block text-xs text-text-2">材料角色</span>
              <select
                aria-label="材料角色"
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
            <CourseSourcePurposeSelect value={purpose} disabled={busy} onChange={setPurpose} />
            <button type="button" className={ui.primary} disabled={busy || !selected.length || needsRefresh} onClick={() => void confirm()}>
              <FolderInput size={14} aria-hidden="true" />
              {busy ? "正在挂接…" : `确认挂接${selected.length ? `（${selected.length}）` : ""}`}
            </button>
          </div>
          <p className="text-xs leading-6 text-text-3">{SOURCE_PURPOSE_HELP}</p>
          <p className="text-xs leading-6 text-text-3">{SOURCE_PURPOSE_SCOPE}</p>
          {needsRefresh ? <button type="button" className={ui.secondary} disabled={busy || loading} onClick={() => { setOpen(false); onAdded(); }}>刷新课程材料后核对</button> : null}
          {result ? (
            <div role="status" className="space-y-1 text-xs text-text-2">
              <p>
                {result.succeeded.length} 份挂接成功
                {result.failed.length ? `，${result.failed.length} 份未完成` : ""}。
              </p>
              {result.failed.map((item) => (
                <p key={item.id} className="break-words text-danger">
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
