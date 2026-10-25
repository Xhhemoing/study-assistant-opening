"use client";
import { userFacingMessage } from "../../../lib/user-facing-error";

/**
 * V2-11 Experience — intervention preference controls.
 * Nest into existing settings / teaching chrome (no new settings product).
 * Wire GET/PUT /api/opening/intervention-settings via OpeningApi.
 *
 * Align: session > course > global; help-seeking ≠ interrupt;
 * quiet still answers help; no dwell-stuck; no auto-expand after hint;
 * no N-minute nag UI. Session temp ≠ permanent must stay visible.
 */

import {
  DEFAULT_OPENING_INTERVENTION_PREFS,
  interventionSettingsResponseSchema,
  type InterventionDepth,
  type InterventionPrefs,
  type InterventionPrefsPatch,
  type InterventionProactivity,
  type InterventionSettingsResponse,
} from "@aistudy/contracts";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui } from "../design/ui";


export type PreferenceControlsScope = "global" | "session";

export type PreferenceControlsProps = {
  /** global = durable workspace prefs; session = activity checkpoint temp overlay. */
  scope?: PreferenceControlsScope;
  courseId?: string | null;
  activityId?: string | null;
  /** CAS token for session overlay writes (activity updatedAt). */
  expectedUpdatedAt?: string | null;
  compact?: boolean;
  api?: OpeningApi;
};

export type WinningLayer = "session" | "course" | "global";

const PROACTIVITY_OPTIONS: { value: InterventionProactivity; label: string }[] = [
  { value: "off", label: "关闭主动介入" },
  { value: "minimal", label: "极少" },
  { value: "balanced", label: "适中（默认）" },
  { value: "high", label: "较多" },
];

const DEPTH_OPTIONS: { value: InterventionDepth; label: string }[] = [
  { value: "hint_only", label: "仅提示（主动不给完整解答）" },
  { value: "hint_then_offer", label: "提示后可询问是否加深（默认）" },
  { value: "full_ok_on_request", label: "主动最多询问；完整解答需你主动求助" },
];

export function winningLayer(data: InterventionSettingsResponse): WinningLayer {
  if (data.sessionOverride != null && Object.keys(data.sessionOverride).length > 0) {
    return "session";
  }
  if (data.courseOverride != null && Object.keys(data.courseOverride).length > 0) {
    return "course";
  }
  return "global";
}

export function winningLayerLabel(layer: WinningLayer): string {
  switch (layer) {
    case "session":
      return "本课临时覆盖（优先）";
    case "course":
      return "课程覆盖";
    default:
      return "全局偏好";
  }
}

function patchFromDraft(draft: InterventionPrefs): InterventionPrefsPatch {
  return {
    proactivity: draft.proactivity,
    nodes: { ...draft.nodes },
    depth: draft.depth,
    quietMode: draft.quietMode,
  };
}

function PrefsFields({
  draft,
  busy,
  idPrefix,
  onChange,
}: {
  draft: InterventionPrefs;
  busy: boolean;
  idPrefix: string;
  onChange: (next: InterventionPrefs) => void;
}) {
  return (
    <fieldset disabled={busy} className="space-y-3">
      <legend className="sr-only">介入偏好字段</legend>
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm text-text-2">
        <span>安静模式（抑制主动提议；仍回答你的求助）</span>
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={draft.quietMode}
          onChange={(e) => onChange({ ...draft, quietMode: e.target.checked })}
          aria-describedby={`${idPrefix}-quiet-help`}
        />
      </label>
      <p id={`${idPrefix}-quiet-help`} className="text-xs leading-5 text-text-3">
        安静 / 关闭主动介入不会把「你主动求助」当成打断；系统仍应回答。不按停留时间推断卡住，也不会在提示后自动展开完整解答，也没有「每 N 分钟必问」控件。
      </p>
      <label className="block space-y-1.5">
        <span className={ui.label}>主动程度</span>
        <select
          className={ui.input}
          value={draft.proactivity}
          onChange={(e) =>
            onChange({
              ...draft,
              proactivity: e.target.value as InterventionProactivity,
            })
          }
        >
          {PROACTIVITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5">
        <span className={ui.label}>深度上限</span>
        <select
          className={ui.input}
          value={draft.depth}
          onChange={(e) =>
            onChange({ ...draft, depth: e.target.value as InterventionDepth })
          }
        >
          {DEPTH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1.5">
        <span className={ui.label}>允许主动介入的节点</span>
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-1 text-sm text-text-2">
          <span>讲解段</span>
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={draft.nodes.allowOnTeach}
            onChange={(e) =>
              onChange({
                ...draft,
                nodes: { ...draft.nodes, allowOnTeach: e.target.checked },
              })
            }
          />
        </label>
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-1 text-sm text-text-2">
          <span>练习 / 提问段</span>
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={draft.nodes.allowOnPrompt}
            onChange={(e) =>
              onChange({
                ...draft,
                nodes: { ...draft.nodes, allowOnPrompt: e.target.checked },
              })
            }
          />
        </label>
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-1 text-sm text-text-2">
          <span>证据不足时仍可主动（默认关）</span>
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={draft.nodes.allowOnLowEvidence}
            onChange={(e) =>
              onChange({
                ...draft,
                nodes: { ...draft.nodes, allowOnLowEvidence: e.target.checked },
              })
            }
          />
        </label>
      </div>
    </fieldset>
  );
}

function EffectiveSummary({ data }: { data: InterventionSettingsResponse }) {
  const layer = winningLayer(data);
  const e = data.effective;
  return (
    <div
      className="space-y-1.5 rounded-lg border border-line bg-surface-2 p-3"
      data-intervention-effective="true"
      data-winning-layer={layer}
    >
      <h3 className="text-xs font-medium text-text">当前生效（已合并）</h3>
      <p className="text-xs leading-5 text-text-2">
        优先层：<strong>{winningLayerLabel(layer)}</strong>
        {" · "}顺序：本课临时 &gt; 课程 &gt; 全局
      </p>
      <dl className="space-y-1 text-xs leading-6 text-text-2">
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-text-3">安静模式</dt>
          <dd>{e.quietMode ? "开" : "关"}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-text-3">主动程度</dt>
          <dd>{PROACTIVITY_OPTIONS.find((o) => o.value === e.proactivity)?.label ?? e.proactivity}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-text-3">深度</dt>
          <dd>{DEPTH_OPTIONS.find((o) => o.value === e.depth)?.label ?? e.depth}</dd>
        </div>
      </dl>
      {data.sessionOverride ? (
        <p
          className="text-xs leading-5 text-warn"
          role="status"
          data-session-temp-banner="true"
        >
          本课临时偏好已启用，只影响当前教学活动，不会写回全局或课程永久设置。
        </p>
      ) : null}
      {data.invalidStoredSettings ? (
        <p className="text-xs text-warn" role="alert">
          已保存的偏好无效，已回退默认值。请重新选择后保存，或重置。
        </p>
      ) : null}
    </div>
  );
}

export type PreferenceControlsViewProps = {
  scope: PreferenceControlsScope;
  compact?: boolean;
  data: InterventionSettingsResponse;
  draft: InterventionPrefs;
  busy: boolean;
  error?: string;
  notice?: string;
  onDraftChange: (next: InterventionPrefs) => void;
  onSave: () => void;
  onReset: () => void;
  onReload: () => void;
};

/** Presentational form — SSR / unit friendly; container wires fetch. */
export function PreferenceControlsView({
  scope,
  compact = false,
  data,
  draft,
  busy,
  error = "",
  notice = "",
  onDraftChange,
  onSave,
  onReset,
  onReload,
}: PreferenceControlsViewProps) {
  const idPrefix = scope === "session" ? "intervention-session" : "intervention-global";
  const heading =
    scope === "session" ? "本课临时介入偏好" : "教学介入偏好";
  const description =
    scope === "session"
      ? "仅覆盖当前教学活动；关闭或重置后恢复课程/全局。与永久设置分开保存。"
      : "控制主动提示程度与深度。可随时查看生效层、重置。求助不等于打断。";

  return (
    <div
      className={compact ? "space-y-3" : "space-y-4"}
      data-preference-controls="true"
      data-intervention-scope={scope}
    >
      {!compact ? (
        <div>
          <h3 className="text-sm font-medium text-text" id={`${idPrefix}-heading`}>
            {heading}
          </h3>
          <p className="mt-1 text-xs leading-6 text-text-3">{description}</p>
        </div>
      ) : (
        <p className="text-xs leading-5 text-text-3">{description}</p>
      )}

      {error ? (
        <p role="alert" className="text-sm leading-6 text-danger">
          {error}
        </p>
      ) : null}

      <EffectiveSummary data={data} />
      <PrefsFields
        draft={draft}
        busy={busy}
        idPrefix={idPrefix}
        onChange={onDraftChange}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={ui.primary} disabled={busy} onClick={onSave}>
          {busy ? (
            <LoaderCircle
              size={14}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Save size={14} aria-hidden />
          )}
          {scope === "session" ? "保存本课临时" : "保存介入偏好"}
        </button>
        <button type="button" className={ui.secondary} disabled={busy} onClick={onReset}>
          {scope === "session" ? "清除本课临时" : "重置为默认"}
        </button>
        <button type="button" className={ui.quiet} disabled={busy} onClick={onReload}>
          <RefreshCw size={14} aria-hidden />
          重新读取
        </button>
      </div>

      {notice ? (
        <p role="status" className="text-sm leading-6 text-accent">
          {notice}
        </p>
      ) : null}

      <span className="sr-only" data-no-nag-interval="true" data-no-dwell-stuck="true">
        无每 N 分钟必问控件；无停留时间卡住推断。
      </span>
    </div>
  );
}

export function PreferenceControls({
  scope = "global",
  courseId = null,
  activityId = null,
  expectedUpdatedAt = null,
  compact = false,
  api: suppliedApi,
}: PreferenceControlsProps) {
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [data, setData] = useState<InterventionSettingsResponse | null>(null);
  const [draft, setDraft] = useState<InterventionPrefs | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");


  const query = useMemo(
    () => ({
      courseId: courseId ?? undefined,
      activityId: scope === "session" ? (activityId ?? undefined) : undefined,
    }),
    [scope, courseId, activityId],
  );

  const receive = useCallback((next: InterventionSettingsResponse) => {
    setData(next);
    // Edit target: session overlay edits effective-as-patch baseline; global edits stored settings.
    setDraft(
      scope === "session"
        ? { ...next.effective }
        : { ...next.settings },
    );
  }, [scope]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError("");
      try {
        const next = await api.getInterventionSettings(query);
        if (!signal?.aborted) receive(interventionSettingsResponseSchema.parse(next));
      } catch (failure) {
        if (!signal?.aborted) {
          setError(userFacingMessage(failure, "介入偏好暂时无法读取，请重试。"));
        }
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [api, query, receive],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);



  async function save(value: InterventionPrefs | InterventionPrefsPatch | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.putInterventionSettings(value, {
        ...query,
        expectedUpdatedAt:
          scope === "session" ? (expectedUpdatedAt ?? undefined) : undefined,
      });
      receive(interventionSettingsResponseSchema.parse(next));
      if (value === null) {
        setNotice(
          scope === "session"
            ? "已清除本课临时偏好，恢复课程/全局生效值。"
            : "已恢复默认介入偏好。",
        );
      } else {
        setNotice(
          scope === "session"
            ? "本课临时偏好已保存（不会写回永久设置）。"
            : "介入偏好已保存。",
        );
      }
    } catch (failure) {
      setError(userFacingMessage(failure, "介入偏好保存失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  if (scope === "session" && !activityId) {
    return (
      <p className="text-xs text-text-3" role="status" data-intervention-session-missing="true">
        无教学活动时无法设置本课临时偏好。
      </p>
    );
  }

  if (busy && !data) {
    return (
      <div
        className={compact ? "space-y-3" : "space-y-4"}
        data-preference-controls="true"
        data-intervention-scope={scope}
      >
        {error ? (
          <p role="alert" className="text-sm leading-6 text-danger">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-text-3" role="status">
          正在读取介入偏好…
        </p>
        <span className="sr-only" data-no-nag-interval="true" data-no-dwell-stuck="true">
          无每 N 分钟必问控件；无停留时间卡住推断。
        </span>
      </div>
    );
  }

  if (!data || !draft) {
    return (
      <div
        data-preference-controls="true"
        data-intervention-scope={scope}
      >
        {error ? (
          <p role="alert" className="text-sm leading-6 text-danger">
            {error}
          </p>
        ) : null}
        <button type="button" className={ui.quiet} onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden />
          重新读取
        </button>
      </div>
    );
  }

  return (
    <PreferenceControlsView
      scope={scope}
      compact={compact}
      data={data}
      draft={draft}
      busy={busy}
      error={error}
      notice={notice}
      onDraftChange={(next) => {
        setDraft(next);
        setNotice("");
      }}
      onSave={() =>
        void save(scope === "session" ? patchFromDraft(draft) : draft)
      }
      onReset={() => void save(null)}
      onReload={() => void load()}
    />
  );
}

/** Defaults re-export for tests / reset copy. */
export { DEFAULT_OPENING_INTERVENTION_PREFS };
