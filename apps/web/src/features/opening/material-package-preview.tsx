import type { ReactNode } from "react";
import { readMaterialPackagePreview, type MaterialPackagePreviewCandidate } from "./material-package-preview-model";

export interface MaterialPackagePreviewProps {
  candidate: MaterialPackagePreviewCandidate | null | undefined;
}

function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <details className="rounded-xl border border-border p-4">
    <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{title}</summary>
    <div className="mt-4 space-y-3">{children}</div>
  </details>;
}

/** Default read-only. No fetch, import, persistence, diagnosis, selection or grading side effects. */
export function MaterialPackagePreview({ candidate }: MaterialPackagePreviewProps) {
  const data = readMaterialPackagePreview(candidate);
  if (!data) return <section aria-label="课程包预览" className="rounded-xl border border-border p-5">
    <h2 className="font-semibold">暂不可预览</h2>
    <p className="mt-2 text-sm text-muted-foreground">课程包为空或离线候选数据不一致。请提供已适配且边界完整的 proposed 候选；不会导入、诊断或评分。</p>
  </section>;

  const skills = new Map(data.routeInput.requirements.map(s => [s.externalSkillId, s]));
  const questions = new Map(data.questionMappings.map(q => [q.id, q]));
  const skillLabel = (id: string) => skills.get(id)!.title;
  const questionLabel = (id: string) => {
    const q = questions.get(id)!;
    return `第${q.topic}章 · ${q.kind === "Test" ? "选择题" : "解答题"}${q.number}（${q.id}）`;
  };
  const binding = (value: string | number | null) => value === null ? "待绑定" : String(value);
  const questionList = (ids: string[]) => ids.length ? <ul className="space-y-2 text-sm">
    {ids.map(id => <li key={id}>{questionLabel(id)} · {skillLabel(questions.get(id)!.primarySkillId)}</li>)}
  </ul> : <p className="text-sm text-muted-foreground">暂无条目</p>;

  return <section aria-label="课程包预览" className="space-y-4 text-foreground">
    <header className="space-y-2 rounded-xl border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">离线候选 · proposed · 未发布</p>
      <h2 className="text-xl font-semibold">真实课程包预览</h2>
      <p className="text-sm font-medium">仅供审阅，不是首答界面 · 无题干，尚不可首答</p>
      <p className="text-sm">仅核对资料映射与建议顺序。这是离线中间表示，不是现行导入格式，也不代表课程已创建。</p>
      <dl className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
        {([["题目映射", data.questionMappings.length], ["考点", skills.size], ["来源 PDF", data.sources.length], ["主诊断候选", data.diagnostic.questionIds.length]] as const).map(([title, count]) =>
          <div key={title} className="rounded-lg bg-muted p-3"><dt className="text-sm text-muted-foreground">{title}</dt><dd className="text-2xl font-semibold">{count}</dd></div>)}
      </dl>
    </header>

    <aside aria-label="使用边界" className="space-y-2 rounded-xl border border-border bg-muted p-4 text-sm">
      <p className="font-medium">全部考点：未测 · 待绑定 · 待正文 · 待可信评分</p>
      <p>作答后备注、学习目标与常见错因不进入此预览内容，也不得向首答者展示；反馈元数据不是评分证据。</p>
      <p>暂无题干和答案；所有题目均不可评分、不可进入 BKT，未建立学习者状态、未校准。映射与诊断候选不代表已掌握、独立作答或考试分数。</p>
      <p>默认只读：不自动导入、不自动诊断或选题、不保存、不评分。确认绑定、检查正文与参考答案并取得合格运行时证据后，才可在其他正式流程中继续。</p>
    </aside>

    <Detail title="绑定与时间信息">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {([["归属用户", data.ownerUserId], ["课程", data.courseId], ["路线版本", data.routeVersion], ["教学版本", data.teachingVersion],
          ["计划截止时间", data.deadlineAt], ["实际考试日期", data.schedule.actualExamDate], ["每日学习分钟", data.schedule.dailyStudyMinutes]] as const).map(([title, value]) =>
          <div key={title}><dt className="text-muted-foreground">{title}</dt><dd>{binding(value)}</dd></div>)}
      </dl>
      <p className="text-sm text-muted-foreground">未知值保持为空值，不把产品使用目标当作考试日期，不假设每日预算或七日计划。</p>
    </Detail>

    <Detail title={`主诊断入口：${data.diagnostic.questionIds.length} 道候选，尚未施测`}>
      <p className="text-sm">仅展示原有主入口，不生成或自动选择新题。待检查参考答案、既往接触、独立作答与可信评分；本组件没有开始诊断操作。</p>
      {questionList(data.diagnostic.eligibleEntryQuestionIds)}
      {data.diagnostic.blockedEntryQuestionIds.length > 0 && <div><h3 className="font-medium">入口内已阻止</h3>{questionList(data.diagnostic.blockedEntryQuestionIds)}</div>}
      <h3 className="font-medium">解答题补充候选（不是另一套主诊断）</h3>
      {questionList(data.diagnostic.constructedResponseCandidates)}
    </Detail>

    <Detail title={`禁止进入诊断：${data.validation.visualCheckRequired.length} 道待视觉核对，${data.validation.disputedDiagnosticExclusions.length} 道材料争议`}>
      <h3 className="font-medium">公式或版式待视觉核对 · 已排除</h3>
      {questionList(data.validation.visualCheckRequired)}
      <h3 className="font-medium">材料争议 · 已排除</h3>
      {questionList(data.validation.disputedDiagnosticExclusions)}
      <p className="text-sm text-muted-foreground">核对文本不等于完成数学验证；以上条目不能因存在题号或考点映射而进入诊断、评分或 BKT。</p>
    </Detail>

    <Detail title={`覆盖缺口：${data.coverageGaps.length} 项已声明，清单不穷尽`}>
      <ul className="space-y-3 text-sm">{data.coverageGaps.map((gap, index) => <li key={`${gap.skillId}-${index}`}>
        <h3 className="font-medium">{skillLabel(gap.skillId)}</h3><p>{gap.scope}</p>
        <p className="text-muted-foreground">待核对候选来源：{gap.candidateSource}</p>
      </li>)}</ul>
      <p className="text-sm text-muted-foreground">现有题量不等于完整覆盖；未列出的缺口仍可能存在。</p>
      {data.coverageGapNotes.length > 0 && <p className="text-sm">资料另有补充缺口说明，仍需按原始资料核对。</p>}
    </Detail>

    <Detail title="考点、先修与建议路线（全部未测）">
      <p className="text-sm">以下仅按资料给定的先修顺序展示，不是个性化学习安排。先确认时间预算并完成真实诊断，再在正式流程中决定学习单元。</p>
      <p className="text-sm font-medium">概念桥接建议：全部未测；可跳过，不计掌握，不永久挡课。</p>
      <ol className="space-y-3">{data.prerequisiteOrder.map(id => {
        const skill = skills.get(id)!;
        return <li key={id} className="rounded-lg bg-muted p-3 text-sm">
          <h3 className="font-medium">{skill.title} · 未测</h3>
          <p className="text-muted-foreground">先修：{skill.prerequisiteSkillIds.length ? skill.prerequisiteSkillIds.map(skillLabel).join("、") : "资料未声明先修"}</p>
          {data.prerequisiteGuidance.conceptBridges.filter(b => b.targetSkillId === id).map(b => <p key={b.prerequisiteSkillId}>
            概念桥接：{skillLabel(b.prerequisiteSkillId)} · 未测 · 可跳过 · 不计掌握
          </p>)}
          <p className="text-muted-foreground">来源：{skill.sourceRefs.map(r => `${r.file} 第${r.page}页`).join("；")}</p>
        </li>;
      })}</ol>
    </Detail>

    <Detail title={`来源文件：${data.sources.length} 份，均待绑定`}>
      <ul className="space-y-2 text-sm">{data.sources.map(source => <li key={source.file} className="break-words">
        {source.file} · {source.physicalPages} 页 · 数据库来源待绑定
      </li>)}</ul>
    </Detail>

    <Detail title={`完整题目映射：${data.questionMappings.length} 条，无题干与答案`}>
      <ul className="space-y-3 text-sm">{data.questionMappings.map(q => <li key={q.id} className="rounded-lg bg-muted p-3">
        <h3 className="font-medium">{questionLabel(q.id)} · {skillLabel(q.primarySkillId)}</h3>
        {q.secondarySkillIds.length > 0 && <p>关联考点：{q.secondarySkillIds.map(skillLabel).join("、")}</p>}
        <p className="text-muted-foreground">{q.sourceFile} 第{q.physicalPage}页</p>
        <p>{q.assessmentReadiness === "blocked-author-exclusion" ? "材料争议或作者排除 · 不可进入诊断" : q.mappingStatus === "needs-visual-check" || q.assessmentReadiness === "blocked-visual-check" ? "待视觉核对 · 不可进入诊断" : q.assessmentReadiness === false || q.bktAdmission === false || !q.diagnosticEligible ? "当前不可进入诊断 · 尚不可首答" : "文本映射已核对 · 数学内容未完成验证"}</p>
        <p className="text-muted-foreground">待正文 · 待参考答案 · 不可评分 · 不可进入 BKT{q.diagnosticEntryCandidate ? " · 主诊断候选（未施测）" : ""}</p>
      </li>)}</ul>
    </Detail>
  </section>;
}
