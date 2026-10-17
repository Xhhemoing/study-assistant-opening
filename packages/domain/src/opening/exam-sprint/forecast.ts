import type { ExamForecastOverview, ExamPaper } from "@aistudy/contracts";

/** Integer-parameter Beta CDF via a binomial tail; log terms avoid coefficient overflow. */
function betaQuantile(probability: number, a: number, b: number): number {
  const n = a + b - 1;
  const logCoefficients = [0];
  for (let j = 1; j <= n; j++) logCoefficients.push(logCoefficients[j - 1]! + Math.log(n - j + 1) - Math.log(j));
  const cdf = (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let sum = 0;
    for (let j = a; j <= n; j++) sum += Math.exp(logCoefficients[j]! + j * Math.log(x) + (n - j) * Math.log1p(-x));
    return Math.min(1, sum);
  };
  let lower = 0;
  let upper = 1;
  for (let step = 0; step < 60; step++) {
    const mid = (lower + upper) / 2;
    if (cdf(mid) < probability) lower = mid;
    else upper = mid;
  }
  return (lower + upper) / 2;
}

export function forecastExamTopics(papers: ExamPaper[], skillIds: string[], teacher: string | null): ExamForecastOverview {
  const selectedTeacher = teacher?.trim() || null;
  const byId = new Map<string, ExamPaper>();
  for (const paper of papers) {
    const current = byId.get(paper.id);
    if (!current || Date.parse(paper.recordedAt) > Date.parse(current.recordedAt)) byId.set(paper.id, paper);
  }
  // A second registration of the same frozen source is not an independent exam.
  const bySourceVersion = new Map<string, ExamPaper>();
  for (const paper of byId.values()) {
    const sourceKey = `${paper.sourceId}:${paper.sourceVersion}`;
    const current = bySourceVersion.get(sourceKey);
    if (!current || Date.parse(paper.recordedAt) > Date.parse(current.recordedAt)) bySourceVersion.set(sourceKey, paper);
  }
  const listed = [...bySourceVersion.values()].filter(paper => selectedTeacher === null || paper.teacher === selectedTeacher);
  const historical = selectedTeacher === null ? [] : listed.filter(paper => paper.kind === "past_exam");
  const n = historical.length;
  const topics = [...new Set(skillIds)].map(skillId => {
    const checked = historical.flatMap(paper => {
      const skill = paper.skills.find(item => item.skillId === skillId);
      return skill ? [skill] : [];
    });
    const checkedPapers = checked.length;
    const k = checked.filter(skill => skill.points > 0).length;
    return {
      skillId, examinedPapers: k, totalPapers: checkedPapers,
      probability: checkedPapers ? (k + 1) / (checkedPapers + 2) : null,
      lower: checkedPapers ? betaQuantile(0.025, k + 1, checkedPapers - k + 1) : null,
      upper: checkedPapers ? betaQuantile(0.975, k + 1, checkedPapers - k + 1) : null,
      meanPoints: checkedPapers ? checked.reduce((sum, skill) => sum + skill.points, 0) / checkedPapers : null,
    };
  });
  const limited = n < 10 || topics.some(topic => topic.totalPapers < 10);
  return {
    teacher: selectedTeacher, papers: structuredClone(listed),
    topics,
    status: !n ? "no_history" : limited ? "limited_history" : "history_based",
    message: !n
      ? "尚无选定老师的已登记真卷，无法估计考点出现概率。样卷和练习只作材料依据，不计入历史样本；请先选择老师并登记独立真卷。"
      : `已登记老师「${selectedTeacher}」的${n}份独立真卷；各技能仅以明确核对过分值的真卷为分母，分值大于0计出现、0计未出现，留空视为未知并排除。按Beta(1,1)先验更新，区间为95%等尾可信区间，平均分值也仅按该技能已核对真卷计算。`
        + (limited ? "部分技能的已核对历史少于10份或尚未核对，估计不稳定；没有技能样本时不显示概率。" : "历史频率仍会受到课程与命题变化影响。")
        + "样卷和练习不计概率样本；这些是历史材料估计，不是命题保证或完整试卷预测。",
  };
}
