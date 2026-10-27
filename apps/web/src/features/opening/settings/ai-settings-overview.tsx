import type { OpeningAiSettingsResponse } from "@aistudy/contracts";
import { effectiveModelRoutes, effectiveTaskRoutes } from "./ai-settings-model";

/** The summary uses saved settings; editing a draft must not relabel the current model. */
export function AiSettingsOverview({ data }: { data: OpeningAiSettingsResponse }) {
  const routes = effectiveModelRoutes(data, data.settings);
  const taskOverrides = effectiveTaskRoutes(data, data.settings).filter(route => {
    const saved = data.settings.taskRoutes?.[route.task.key];
    return saved?.primary || saved?.fallback;
  });
  const followsDefault = data.settings.mode === "automatic" && !data.settings.defaultModelId
    && Object.values(data.settings.routes).every(id => id === null) && !taskOverrides.length
    && routes.every(route => route.model?.source !== "workspace");
  const singleModel = routes.every(route => route.id === routes[0]?.id);
  const visibleRoutes = data.settings.mode === "manual" || singleModel ? routes.slice(0, 1) : routes;
  const unlimited = data.dailyQuota?.mode === "unlimited";
  const cap = data.dailyQuota?.mode === "limited" ? data.dailyQuota.capCents : data.dailyCapCents;
  const usage = data.dailyUsage;
  return <section aria-label="当前模型与用量" className="space-y-3">
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-text">{followsDefault ? "服务器默认模型" : "当前模型"}</h3>
      <dl className="space-y-1 text-sm leading-6">{visibleRoutes.map(route => <div key={route.mode}>
        <dt className={!singleModel && data.settings.mode !== "manual" ? "text-xs text-text-3" : "sr-only"}>{singleModel || data.settings.mode === "manual" ? "所有辅导模式" : route.label}</dt>
        <dd className={route.problem ? "text-warn" : "text-text"}>{route.model ? `${route.model.providerLabel} · ${route.model.label}（${route.model.modelName}）` : "尚未配置模型"}{route.problem ? ` · ${route.problem}` : ""}</dd>
      </div>)}</dl>
      {taskOverrides.length ? <dl className="space-y-1 text-xs leading-6">{taskOverrides.map(route => <div key={route.task.key}>
        <dt className="text-text-3">{route.task.label}</dt>
        <dd className={route.problem ? "text-warn" : "text-text"}>{route.model ? `${route.model.providerLabel} · ${route.model.label}` : "尚未配置模型"}{route.problem ? ` · ${route.problem}` : ""}{route.fallbackModel ? `；备用 ${route.fallbackModel.label}` : ""}{route.fallbackProblem ? ` · ${route.fallbackProblem}` : ""}</dd>
      </div>)}</dl> : null}
      {data.invalidStoredSettings ? <p role="alert" className="text-sm text-warn">已保存的模型设置无效，AI 请求已暂停。请展开下方设置重新保存，或恢复服务器默认设置。</p> : null}
    </div>
    <div id="daily-budget" className="scroll-mt-6 space-y-1 text-sm leading-6">
      <p className="font-medium text-text">{unlimited ? "测试期每日不限额" : `每日上限 ${cap} 分`}</p>
      {usage ? <>
        <p className="text-text">今日已用 {usage.spentCents} 分</p>
        <p className="text-text-2">待结算预留 {usage.reservedCents} 分<span className="text-xs">（含此前未结算请求，不等于今日花费）</span></p>
        <p className="text-xs text-text-3">{usage.localDate} · {usage.timeZone}</p>
      </> : <p className="text-text-2">今日用量暂不可用</p>}
    </div>
  </section>;
}
