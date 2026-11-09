"use client";

import { useEffect, useRef, useState } from "react";
import { LoadError, ui } from "../design/ui";
import {
  CourseSourcePurposeError, createCourseSourcePurposeClient, sourcePurposeLabel, sourcePurposeLabels,
  SOURCE_PURPOSE_HELP, SOURCE_PURPOSE_SCOPE,
  type CourseSourceMembership, type CourseSourcePurpose, type CourseSourcePurposeClient,
} from "./course-source-purpose-client";

export function CourseSourcePurposeSelect({ value, disabled, onChange }: {
  value: CourseSourcePurpose; disabled: boolean; onChange: (value: CourseSourcePurpose) => void;
}) {
  return <label className="space-y-1 text-xs text-text-2">
    <span className="block">本课程用途</span>
    <select className={ui.input} aria-label="本课程用途" value={value ?? ""} disabled={disabled}
      onChange={event => onChange(event.target.value === "" ? null : event.target.value as Exclude<CourseSourcePurpose, null>)}>
      <option value="">未分类</option>
      {Object.entries(sourcePurposeLabels).map(([purpose, label]) => <option key={purpose} value={purpose}>{label}</option>)}
    </select>
  </label>;
}

/** Keyed by course/source so an outstanding request cannot populate another course. */
export function CourseSourcePurposeControl(props: {
  courseId: string; sourceId: string; sourceName: string; client?: CourseSourcePurposeClient;
}) {
  return <PurposeControl key={`${props.courseId}:${props.sourceId}`} {...props} />;
}
function PurposeControl({ courseId, sourceId, sourceName, client }: {
  courseId: string; sourceId: string; sourceName: string; client?: CourseSourcePurposeClient;
}) {
  const api = useRef(client ?? createCourseSourcePurposeClient()).current;
  const [current, setCurrent] = useState<CourseSourceMembership | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CourseSourcePurpose>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    let valid = true;
    setBusy(true); setError(""); setCurrent(null); setEditing(false);
    api.read(courseId, sourceId).then(row => {
      if (valid) { setCurrent(row); setNeedsRefresh(false); }
    }).catch(reason => {
      if (valid) setError(reason instanceof CourseSourcePurposeError ? reason.message : "暂时无法核对材料用途，请刷新重试。");
    }).finally(() => { if (valid) setBusy(false); });
    return () => { valid = false; active.current = false; };
  }, [api, courseId, sourceId, revision]);

  async function save() {
    if (!current || !editing || draft === current.purpose || inFlight.current || needsRefresh) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const row = await api.update(courseId, current, draft);
      if (active.current) { setCurrent(row); setEditing(false); setNotice("本课程用途已保存。"); }
    } catch (reason) {
      if (!active.current) return;
      setNeedsRefresh(true); setEditing(false);
      setError(reason instanceof CourseSourcePurposeError ? reason.message : "用途保存结果尚未确认，请刷新核对后再操作；不会自动重试。");
      if (reason instanceof CourseSourcePurposeError && (reason.status === 409 || reason.code === "CONFLICT")) {
        // A conflict only refreshes the snapshot. Never replays the user's draft.
        try {
          const latest = await api.read(courseId, sourceId);
          if (active.current) { setCurrent(latest); setNeedsRefresh(false); }
        } catch { if (active.current) setCurrent(null); }
      } else if (reason instanceof CourseSourcePurposeError && [401, 403, 404].includes(reason.status)) {
        setCurrent(null);
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <section aria-label={`${sourceName}的本课程用途`} className="w-full space-y-2 text-xs text-text-2">
    <div className="flex flex-wrap items-center gap-2">
      <span>{current ? `用途：${sourcePurposeLabel(current.purpose)}` : busy ? "正在核对用途…" : "用途暂不可核对"}</span>
      {!editing && current && !needsRefresh ? <button type="button" className={ui.quiet} disabled={busy}
        onClick={() => { setDraft(current.purpose); setEditing(true); setError(""); setNotice(""); }}>修改用途</button> : null}
      {!editing ? <button type="button" className={ui.quiet} disabled={busy} onClick={() => { setNotice(""); setRevision(value => value + 1); }}>刷新用途</button> : null}
    </div>
    {editing && current ? <div className="space-y-2 rounded-lg border border-line p-3">
      <CourseSourcePurposeSelect value={draft} disabled={busy} onChange={setDraft} />
      <p className="leading-6">{SOURCE_PURPOSE_HELP}</p>
      <p className="leading-6">{SOURCE_PURPOSE_SCOPE}</p>
      <p>确认将本课程用途从“{sourcePurposeLabel(current.purpose)}”改为“{sourcePurposeLabel(draft)}”？</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={ui.primary} disabled={busy || draft === current.purpose || needsRefresh} onClick={() => void save()}>{busy ? "正在保存…" : "确认修改用途"}</button>
        <button type="button" className={ui.quiet} disabled={busy} onClick={() => { setEditing(false); setError(""); }}>取消</button>
      </div>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <LoadError message={error} /> : null}
  </section>;
}
