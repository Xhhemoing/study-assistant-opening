"use client";

import { useMemo } from "react";
import { readMaterialAuthorReadiness } from "./material-author-readiness-model";
import { MaterialAuthorReviewSurface, type MaterialAuthorReviewSurfaceProps } from "./material-author-review-surface";

export type MaterialAuthorReviewHostProps = MaterialAuthorReviewSurfaceProps;

/** Mountable private author composition, NOT an authorization/first-answer boundary.
 * Host authorization and safe delivery of raw author metadata remain external. No
 * readiness bindings, verifier, report or caller-supplied ready flag is accepted here.
 * One captured raw value feeds the model and existing surface props without repair.
 */
export function MaterialAuthorReviewHost(props: MaterialAuthorReviewHostProps) {
  // Capture references once before cloning; getters cannot provide different inputs
  // to the status summary and the review surface during this render.
  const { input, providedSources } = props;
  const validProps = Object.keys(props).every(key => key === "input" || key === "providedSources");
  const raw = useMemo(() => {
    try { return { value: structuredClone(input) }; }
    catch { return null; }
  }, [input]);
  const sources = useMemo(() => {
    try { return { value: structuredClone(providedSources) }; }
    catch { return null; }
  }, [providedSources]);
  const review = useMemo(() => {
    if (!raw || !sources || !validProps || raw.value == null) return null;
    try {
      const model = readMaterialAuthorReadiness(raw.value, { providedSources: sources.value });
      // The model has validated the RAW value using the canonical full-package
      // schema and locator. Keep that raw value, not a trimmed/independent projection.
      return { model, input: raw.value as NonNullable<MaterialAuthorReviewSurfaceProps["input"]> };
    } catch {
      // UI boundary conversion only: never echo validation payloads/private errors.
      return null;
    }
  }, [raw, sources, validProps]);
  if (!review) return <section aria-label="作者资料组合" className="rounded-xl border border-border p-4">
    <p role="alert">作者资料审阅暂不可用，请提供有效资料与来源绑定。正式作答仍未就绪（MODULE_PENDING）。</p>
  </section>;
  const { model } = review;
  return <section aria-label="作者资料组合" className="space-y-6 text-foreground">
    <section aria-label="作者资料就绪状态" className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="text-lg font-semibold">资料审阅可用，正式作答未就绪</h2>
      <p role="status" className="text-sm">{model.moduleStatus} · {model.layers.execution.status}；未执行题目：{model.layers.execution.executedQuestions}</p>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div><dt>资料题目</dt><dd>{model.layers.preview.questions}</dd></div>
        <div><dt>技能</dt><dd>{model.layers.preview.skills}</dd></div>
        <div><dt>来源位置</dt><dd>{model.layers.sources.locations}</dd></div>
        <div><dt>已定位位置</dt><dd>{model.layers.sources.locatedLocations}</dd></div>
        <div><dt>未绑定位置</dt><dd>{model.layers.sources.unboundLocations}</dd></div>
      </dl>
      <p className="text-sm">诊断／评分／BKT 条件就绪题数：{model.layers.execution.contractReadyQuestions.diagnostic}／{model.layers.execution.contractReadyQuestions.scoring}／{model.layers.execution.contractReadyQuestions.bkt}。来源绑定只用于定位，不代表授权。</p>
      <p className="text-sm text-muted-foreground">缺少正式 host 作答流程；PDF 字节与访问权限尚未确认。这里只读审阅，不提供首答、评分或 BKT 执行，也不记录帮助或接触。</p>
    </section>
    <MaterialAuthorReviewSurface input={review.input} providedSources={sources!.value} />
  </section>;
}
