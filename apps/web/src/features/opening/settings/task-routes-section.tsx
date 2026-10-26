"use client";

import type { OpeningAiSettings, OpeningAiSettingsResponse, OpeningModelSummary } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { effectiveTaskRoutes, modelProblemForTask, setTaskRoute, taskGroupLabels, type TaskView } from "./ai-settings-model";

function modelTags(model: OpeningModelSummary): string {
  return [
    model.supportsVision ? "视觉" : null,
    model.supportsAudio ? "音频" : null,
    model.billing === "free_tier" ? "免费额度" : null,
  ].filter(Boolean).join(" · ");
}

function TaskModelSelect({ label, task, models, value, empty, onChange }: {
  label: string; task: TaskView; models: OpeningModelSummary[]; value: string | null; empty: string;
  onChange: (id: string | null) => void;
}) {
  const missing = value !== null && !models.some(model => model.id === value);
  return <label className="block min-w-0 space-y-1"><span className="text-xs font-medium text-text-2">{label}</span>
    <select className={ui.input} value={value ?? ""} onChange={event => onChange(event.target.value || null)}>
      <option value="">{empty}</option>
      {missing ? <option value={value!}>已移除的模型（{value}）</option> : null}
      {models.map(model => {
        const problem = modelProblemForTask(model, task);
        const tags = modelTags(model);
        // Unusable models stay listed with their reason so the choice is explainable.
        return <option key={model.id} value={model.id} disabled={problem !== null && model.id !== value}>
          {model.providerLabel} · {model.label}{tags ? ` · ${tags}` : ""}{problem ? `（${problem}）` : ""}
        </option>;
      })}
    </select>
  </label>;
}

/** Per-task model routes generated from the gateway's task registry. */
export function TaskRoutesSection({ data, draft, onChange }: {
  data: OpeningAiSettingsResponse; draft: OpeningAiSettings; onChange: (value: OpeningAiSettings) => void;
}) {
  const routes = effectiveTaskRoutes(data, draft);
  if (!routes.length) return null;
  const groups = [...new Set(routes.map(route => route.task.group))];
  return <section className="space-y-3 rounded-lg border border-line p-3" aria-labelledby="task-routes-heading">
    <div>
      <h3 id="task-routes-heading" className="text-sm font-medium text-text">按用途指定模型与备用模型</h3>
      <p className="text-xs leading-6 text-text-3">
        {draft.mode === "manual"
          ? "手动选择已锁定所有用途的主模型；这里仍可为每个用途指定备用模型。"
          : "未指定时按上方规则选择。"}
        备用模型只在主模型请求确定没有发出时使用（模型不可用、密钥失效、限流、额度或请求次数用完）；超时或网络中断时不会改用备用模型，避免重复计费。
      </p>
    </div>
    {groups.map(group => <div key={group} className="space-y-2">
      <h4 className="text-xs font-medium text-text-2">{taskGroupLabels[group] ?? group}</h4>
      {routes.filter(route => route.task.group === group).map(route => {
        const stored = draft.taskRoutes?.[route.task.key];
        return <div key={route.task.key} className="space-y-1.5 rounded-md bg-surface-2 p-2" data-task={route.task.key}>
          <p className="text-xs text-text">{route.task.label}
            <span className={route.problem ? "ml-2 text-warn" : "ml-2 text-text-3"}>
              {route.model ? `当前：${route.model.providerLabel} · ${route.model.label}` : "当前：未配置"}{route.problem ? ` · ${route.problem}` : ""}
            </span>
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {draft.mode === "manual" ? null : <TaskModelSelect label="主模型" task={route.task} models={data.models}
              value={stored?.primary ?? null} empty="按上方规则"
              onChange={id => onChange(setTaskRoute(draft, route.task.key, { primary: id }))} />}
            <TaskModelSelect label="备用模型" task={route.task} models={data.models}
              value={stored?.fallback ?? null} empty="不使用备用模型"
              onChange={id => onChange(setTaskRoute(draft, route.task.key, { fallback: id }))} />
          </div>
          {route.fallbackProblem ? <p className="text-xs text-warn" role="status">备用模型：{route.fallbackProblem}</p> : null}
        </div>;
      })}
    </div>)}
    {data.models.some(model => model.billing === "free_tier") ? <p className="text-xs leading-5 text-warn">
      免费额度模型（如 Google Gemini 免费额度）的输入和输出可能被供应商用于改进其产品，并可能经人工审阅；不要用于隐私材料。被标记为隐私排除的材料不会发送。
    </p> : null}
  </section>;
}
