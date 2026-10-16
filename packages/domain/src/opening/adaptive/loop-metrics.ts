import { loopMetricsReportSchema, type LearningEvidenceEligibility, type LoopMetric, type LoopMetricsReport, type PlanFeedbackSummary } from "@aistudy/contracts";

export type LoopMetricsInput = {
  asOf: string; windowStart: string; windowDays: number; timeZone: string;
  jobs: readonly { kind: string; state: string; count: number }[];
  budget: readonly { category: "settled" | "ttl_provisional" | "unknown_reserved" | "active_reserved" | "released"; count: number; cents: number }[];
  observations: readonly { identity: string; occurredAt: string; verificationSource: string; eligibility: LearningEvidenceEligibility }[];
  learningComplete: boolean; privacyExcludedCount: number;
  feedback: PlanFeedbackSummary;
  suggestions: { complete: boolean; generated: number; accepted: number; minutes: number };
  suggestionFeedback?: readonly { reason: string; count: number }[];
  coach?: { accepted: number; undone: number };
  replans?: { created: number; accepted: number; rejected: number };
  evaluations?: { recorded: number; abstained: number };
};

function ratio(id: string, label: string, numerator: number, denominator: number, denominatorLabel: string,
  excludedReasonCounts: Record<string, number> = {}, complete = true): LoopMetric {
  return { id, label, unit: "ratio", value: complete && denominator > 0 ? numerator / denominator : null,
    numerator: complete ? numerator : null, denominator: complete ? denominator : null, sampleSize: denominator,
    denominatorLabel, dataStatus: !complete ? "unknown" : denominator ? "available" : "no_samples", excludedReasonCounts };
}

function count(id: string, label: string, value: number, sampleSize = value, unit: LoopMetric["unit"] = "count"): LoopMetric {
  return { id, label, unit, value: sampleSize ? value : null, numerator: null, denominator: null, sampleSize,
    denominatorLabel: "统计窗口内实际记录", dataStatus: sampleSize ? "available" : "no_samples", excludedReasonCounts: {} };
}

function missing(id: string, label: string, reason: string): LoopMetric {
  return { id, label, unit: "ratio", value: null, numerator: null, denominator: null, sampleSize: 0,
    denominatorLabel: reason, dataStatus: "not_collected", excludedReasonCounts: {} };
}

const qualified = (e: LearningEvidenceEligibility) => e.independentAttempt === "yes"
  && e.verifiedCorrect !== "unknown" && e.usableForCurrentVersion === "yes";

/** A descriptive snapshot. Reference checking, task completion and predictions never establish mastery here. */
export function buildLoopMetricsReport(input: LoopMetricsInput): LoopMetricsReport {
  const runtime: LoopMetric[] = [];
  for (const kind of [...new Set(input.jobs.map(row => row.kind))].sort()) {
    const states = Object.fromEntries(input.jobs.filter(row => row.kind === kind).map(row => [row.state, row.count]));
    const total = Object.values(states).reduce((sum, n) => sum + n, 0);
    for (const state of ["succeeded", "failed", "cancelled", "outcome_unknown", "queued", "running"]) {
      runtime.push({ ...count(`jobs.${kind}.${state}`, `${kind} · ${state}`, states[state] ?? 0, total),
        denominator: total, denominatorLabel: "窗口内创建的同类型任务（按报告时状态）" });
    }
    runtime.push(ratio(`jobs.${kind}.succeeded_ratio`, `${kind} · 创建任务中已成功比例`, states.succeeded ?? 0, total,
      "窗口内创建的同类型任务，包含未结束与结果未知任务"));
  }
  const budgetTotal = input.budget.reduce((sum, row) => sum + row.count, 0);
  const costLabels = { settled: "已结算账面费用", ttl_provisional: "TTL 暂计费用（尚无回执）", unknown_reserved: "结果未知仍保留费用", active_reserved: "普通未结束预留费用", released: "已释放预留记录" };
  for (const category of ["settled", "ttl_provisional", "unknown_reserved", "active_reserved", "released"] as const) {
    const row = input.budget.find(item => item.category === category);
    runtime.push({ ...count(`budget.${category}`, costLabels[category], category === "released" ? row?.count ?? 0 : row?.cents ?? 0,
      budgetTotal, category === "released" ? "count" : "cents"), sampleSize: row?.count ?? 0,
      denominator: budgetTotal, denominatorLabel: "窗口内创建的预留记录；费用按当前账本分类，非支付时段花费" });
  }
  runtime.push(missing("requests.failure_ratio", "请求失败比例", "尚未采集所有请求及失败事件，现存成功行不能构成分母"),
    missing("plans.accept_conflicts", "计划接受冲突", "尚未持久化拒绝原因事件"),
    input.evaluations ? ratio("evaluation.abstention", "已持久化自动评价结果的拒判比例", input.evaluations.abstained, input.evaluations.recorded,
      "窗口内原始服务器评价事实；不按当前head筛选，不含鉴权/规格验证时被拒绝的请求")
      : missing("evaluation.abstention", "已持久化自动评价结果的拒判比例", "本诊断尚未接入服务器评价事实"),
    missing("recovery.success", "恢复结果", "尚未采集完整恢复尝试事件"));

  const observations = input.observations;
  const exclusions: Record<string, number> = { privacy_excluded: input.privacyExcludedCount };
  const positiveReasons = new Set(["reference_checked_correct", "reference_checked_incorrect", "deterministic_correct", "deterministic_incorrect", "version_exact", "version_equivalent_confirmed", "prior_answer_exposure"]);
  for (const row of observations) if (!qualified(row.eligibility)) {
    for (const reason of new Set(row.eligibility.reasonCodes)) {
      if (!positiveReasons.has(reason) && !reason.startsWith("delayed_")) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    }
  }
  if (!input.learningComplete) exclusions.read_limit = 1;
  const checks = observations.filter(row => qualified(row.eligibility));
  const referenceChecks = checks.filter(row => row.verificationSource === "reference_checked");
  const deterministicChecks = checks.filter(row => row.verificationSource === "deterministic");
  const unknown = observations.filter(({ eligibility: e }) => [e.independentAttempt, e.verifiedCorrect, e.usableForCurrentVersion].includes("unknown"));
  const learning = [
    ratio("learning.independent_check_coverage", "当前合格独立核对覆盖（分来源）", checks.length, observations.length,
      "窗口内作答的当前非撤回有效 head，排除隐私材料", exclusions, input.learningComplete),
    ratio("learning.qualification_unknown", "资格仍未知比例", unknown.length, observations.length,
      "同一批当前有效 head，任一独立性/核对/版本资格未知", exclusions, input.learningComplete),
    ratio("learning.checked_correct", "合格独立参考核对正确比例", referenceChecks.filter(row => row.eligibility.verifiedCorrect === "yes").length,
      referenceChecks.length, "独立、当前版本可用且参考核对结论明确的作答（含错误），包含学习者自核", exclusions, input.learningComplete),
    ratio("learning.deterministic_correct", "合格独立确定性评价正确比例", deterministicChecks.filter(row => row.eligibility.verifiedCorrect === "yes").length,
      deterministicChecks.length, "独立、当前版本可用且服务器确定性评价结论明确的作答（含错误），不含自核", exclusions, input.learningComplete),
  ];
  const waits: number[] = [];
  let censored = 0;
  const ordered = [...checks].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (let index = 0; index < ordered.length; index++) {
    const row = ordered[index]!;
    if (row.eligibility.verifiedCorrect !== "no") continue;
    const next = ordered.slice(index + 1).find(other => other.identity === row.identity && Date.parse(other.occurredAt) > Date.parse(row.occurredAt));
    if (next) waits.push((Date.parse(next.occurredAt) - Date.parse(row.occurredAt)) / 60_000);
    else censored++;
  }
  waits.sort((a, b) => a - b);
  const middle = Math.floor(waits.length / 2);
  const median = waits.length ? waits.length % 2 ? waits[middle]! : (waits[middle - 1]! + waits[middle]!) / 2 : null;
  learning.push({ id: "learning.next_check_wait", label: "核对错误后下次合格作答等待中位数", unit: "minutes",
    value: input.learningComplete ? median : null, numerator: null, denominator: waits.length, sampleSize: waits.length + censored,
    denominatorLabel: "同课程、要求及知识点；仅已发生下一次合格作答的间隔，未返回者另列",
    dataStatus: !input.learningComplete ? "unknown" : waits.length ? "available" : "no_samples",
    excludedReasonCounts: { right_censored: censored, ...(!input.learningComplete ? { read_limit: 1 } : {}) } },
    missing("learning.delayed_transfer", "延迟独立新题与迁移结果", "独立测试插件尚未接入本诊断；不从即时完成推断保持"),
    missing("learning.first_attempt", "首次作答表现", "主学习链路未可靠采集稳定题身份首次作答"),
    missing("learning.calibration", "预测校准", "尚未连接持久化事前预测；不能宣称 BKT 收益"));

  const { actions, reasons } = input.feedback;
  const totalActions = Object.values(actions).reduce((sum, n) => sum + n, 0);
  const burden = [
    ...(["done", "skipped", "deferred", "resumed"] as const).map(action => ({
      ...count(`feedback.${action}`, { done: "手动标记完成", skipped: "跳过", deferred: "推迟", resumed: "取消推迟" }[action], actions[action], totalActions),
      denominator: totalActions, denominatorLabel: "窗口内记录的任务操作次数，同一任务可多次操作，不是完成率",
    })),
    ratio("feedback.reason_coverage", "跳过与推迟原因填写比例", reasons.supplied, reasons.eligible,
      "跳过或推迟操作，不含完成与取消推迟", { reason_missing: reasons.missing, prefer_not_say: reasons.declined }),
    ...(["time_short", "too_hard", "too_easy", "not_relevant", "other"] as const).map(reason => ({
      ...count(`feedback.reason.${reason}`, { time_short: "原因：时间不够", too_hard: "原因：太难", too_easy: "原因：太简单", not_relevant: "原因：不适合目标", other: "原因：其他" }[reason], reasons.counts[reason], reasons.eligible),
      denominator: reasons.eligible, denominatorLabel: "窗口内跳过或推迟操作的可选原因记录",
    })),
    ratio("suggestions.generated_acceptance", "规则生成建议中已建任务比例（含未展示草案）", input.suggestions.accepted, input.suggestions.generated,
      "窗口内非对话草案的规则建议按 key 去重，分子是仍保留的对应 planner 任务；含未展示、失效或拒绝草案，不是展示采纳率或完整历史确认率", {}, input.suggestions.complete),
    { ...count("suggestions.generated_minutes", "去重规则生成建议分钟数", input.suggestions.minutes, input.suggestions.generated, "minutes"),
      value: input.suggestions.complete && input.suggestions.generated ? input.suggestions.minutes : null,
      dataStatus: !input.suggestions.complete ? "unknown" as const : input.suggestions.generated ? "available" as const : "no_samples" as const,
      denominatorLabel: "稳定 key 首次生成的时长；不代表实际学习投入" },
    missing("suggestions.display_acceptance", "展示后的采纳比例", "尚未采集建议展示事件"),
    input.replans ? ratio("replan.acceptance", "局部重排草案中已确认比例", input.replans.accepted, input.replans.created,
      "窗口内创建的局部重排草案，含仍待确认；不表示提示展示后的采纳率")
      : missing("replan.acceptance", "局部重排草案中已确认比例", "尚未接入局部重排草案记录"),
    input.replans ? { ...count("replan.rejected", "已拒绝的局部重排草案", input.replans.rejected, input.replans.created),
      denominator: input.replans.created, denominatorLabel: "同一创建 cohort 的草案当前拒绝状态，不含普通聊天计划" }
      : missing("replan.rejected", "已拒绝的局部重排草案", "尚未接入局部重排草案记录"),
    input.coach ? ratio("coach.undo", "教练自动确认的撤销比例", input.coach.undone, input.coach.accepted,
      "窗口内发生的教练确认回执，截至报告时已撤销的次数；没有确认样本时不产生比率")
      : missing("coach.undo", "教练自动确认的撤销比例", "尚未接入教练确认与撤销回执"),
    missing("burden.subjective", "主观学习负担", "尚未采集可选负担评价"),
  ];
  if (input.suggestionFeedback) {
    const total = input.suggestionFeedback.reduce((sum, row) => sum + row.count, 0);
    burden.push({ ...count("suggestions.not_suitable", "明确提交不适合的建议反馈", total),
      denominator: total, denominatorLabel: "持久化不适合表单反馈；普通取消勾选不计数" });
    const labels: Record<string, string> = { time_short: "时间不够", too_hard: "太难", too_easy: "太简单", not_relevant: "不适合目标", other: "其他", prefer_not_say: "不愿说明", missing: "未填写" };
    for (const row of input.suggestionFeedback) burden.push({
      ...count(`suggestions.reason.${row.reason}`, `建议反馈原因：${labels[row.reason] ?? "其他"}`, row.count, total),
      denominator: total, denominatorLabel: "明确提交的不适合建议反馈，不是能力证据",
    });
  } else burden.push(missing("suggestions.not_suitable", "明确提交不适合的建议反馈", "尚未接入建议表单反馈事件"));
  return loopMetricsReportSchema.parse({ metricVersion: "opening-loop-metrics-v1", asOf: input.asOf,
    windowStart: input.windowStart, windowEnd: input.asOf, windowDays: input.windowDays, timeZone: input.timeZone,
    qualification: "current_heads_as_of_report", groups: { runtime, learning, burden },
    notes: ["所有组共享统计区间与报告时点；学习资格按当前有效 head 和当前材料重算，历史修订不会计成新增作答。",
      "任务按创建 cohort 报告当前状态；未结束、失败、取消与结果未知分列，未推断最终成功率或任务延迟。",
      "参考核对包含学习者核对，不能等同客观自动评分；合格错误也属于核对覆盖。",
      "等待时间只描述已返回样本，并列出右删失人数；不将未返回当作零分钟或答错。",
      "操作、生成建议与账面费用均为描述性记录，不构成掌握度、总体评分或教学收益证据。",
      "任务反馈仅覆盖新增事件入口；更早的操作历史未知，补测自动完成不计入手动标记次数。"] });
}
