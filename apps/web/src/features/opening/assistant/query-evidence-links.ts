import type { SystemQueryReceipt } from "@aistudy/contracts";

export type QueryEvidenceLink = { href: string; label: string };
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const NOTE = new RegExp(`^/opening/library/${UUID}$`);
const COURSE = new RegExp(`^/opening/courses/${UUID}(?:/study|/exam|\\?tab=records)?$`);
const MATERIAL = new RegExp(`^/opening/library\\?tab=materials&source=${UUID}&version=(?:0|[1-9][0-9]*)(?:&page=[1-9][0-9]*)?$`);

/** Only the read routes emitted by the query executor; encoded URL interpretation is unnecessary. */
export function isQueryEvidenceHref(href: string): boolean {
  if (/[\s%\\]/.test(href)) return false;
  return ["/opening/today", "/opening/settings", "/opening/library", "/opening/cards", "/opening/sprint"].includes(href)
    || COURSE.test(href) || MATERIAL.test(href) || NOTE.test(href);
}

/** Answer Markdown alone never grants a destination: these come from the server-owned receipt. */
export function queryEvidenceLinks(receipt?: SystemQueryReceipt | null): QueryEvidenceLink[] {
  const links = new Map<string, QueryEvidenceLink>();
  for (const result of receipt?.results ?? []) {
    for (const evidence of result.evidence) {
      if (isQueryEvidenceHref(evidence.href)) links.set(evidence.href, { href: evidence.href, label: evidence.title });
    }
  }
  return [...links.values()];
}

/** Agent 步骤行：助理在回答前读了哪些记录。只来自服务端回执，不由回答正文推断。 */
export type QueryStep = { name: string; label: string; outcome: string; ok: boolean };
const QUERY_LABELS: Record<string, string> = {
  courses: "课程", learning: "学习记录", recommendation: "学习建议", materials: "资料", planning: "学习计划", jobs: "后台任务",
  settings: "设置", teaching: "讲解", learner_state: "掌握情况", explain_decision: "决策依据", notes: "笔记", cards: "卡片", exam_sprint: "考前冲刺", rejected: "未执行的查询",
};
const REASON_LABELS: Record<string, string> = {
  no_data: "没有记录", not_available: "暂不可用", invalid_arguments: "条件不完整", clarification_required: "需要你补充", truncated: "只取了一部分",
  stale: "可能不是最新", timeout: "超时", unavailable: "暂不可用", limit: "达到上限", repeated_query: "重复查询已合并", model_unavailable: "模型不可用", model_unsupported: "模型不支持",
};
export function querySteps(receipt?: SystemQueryReceipt | null): QueryStep[] {
  return (receipt?.results ?? []).map(result => {
    const count = result.data.length;
    const ok = result.status === "ok" && result.reason === "read";
    const outcome = ok ? (count ? `${count} 条` : "没有记录") : REASON_LABELS[result.reason] ?? (count ? `${count} 条` : "没有记录");
    return { name: result.name, label: QUERY_LABELS[result.name] ?? "记录", outcome, ok: ok || result.reason === "no_data" };
  });
}
