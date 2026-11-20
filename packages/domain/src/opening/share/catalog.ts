export type ShareablePitfallEntry = {
  readonly pitfallId: string;
  readonly subjectLabel: string;
  readonly pitfallTitle: string;
  readonly trapSummary: string;
  readonly takeawayRule: string;
  /**
   * Cohort statistics remain honestly unset (0 / null) until backed by real
   * server-side database aggregation with n >= 30 verification.
   */
  readonly cohortSampleSize: 0;
  readonly cohortTrapRate: null;
};

const RAW_SHAREABLE_PITFALL_CATALOG: readonly ShareablePitfallEntry[] = [
  {
    pitfallId: "408-ds-binary-search-bounds",
    subjectLabel: "408 · 数据结构",
    pitfallTitle: "二分查找把 < 和 <= 混用导致死循环",
    trapSummary: "区间定义在 [left, right] 与 [left, right) 之间摇摆，更新 right = mid 或 left = mid 时漏掉边界收缩条件。",
    takeawayRule: "先定区间不变量：闭区间用 <= 且加一减一，左闭右开用 < 且 right = mid。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "408-ds-bfs-visited-timing",
    subjectLabel: "408 · 数据结构",
    pitfallTitle: "BFS 出队时才标记已访问导致节点重复入队",
    trapSummary: "图遍历时把 visited[v] = true 写在出队之后，同一层多条边会把未出队的邻居反复压入队列。",
    takeawayRule: "BFS 标访问必须在入队那一刻完成，确保每个顶点最多进队一次。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "408-os-deadlock-banker-safe",
    subjectLabel: "408 · 操作系统",
    pitfallTitle: "银行家算法把不安全状态等同于已经死锁",
    trapSummary: "看到系统进入不安全状态就直接判定发生死锁，忽略了不安全只是存在死锁风险而非必然死锁。",
    takeawayRule: "安全状态一定无死锁；不安全状态只是可能死锁，死锁一定处于不安全状态。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "408-co-cache-write-allocate",
    subjectLabel: "408 · 计算机组成",
    pitfallTitle: "Cache 写命中策略与写不命中策略张冠李戴",
    trapSummary: "把写回法、全写法与写分配、非写分配混为一谈，导致判断脏位与主存访存次数时出错。",
    takeawayRule: "写命中看全写还是写回，写不命中看是否调块；写回常配写分配，全写常配非写分配。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "408-cn-tcp-congestion-ssthresh",
    subjectLabel: "408 · 计算机网络",
    pitfallTitle: "TCP 超时重传与三重复 ACK 的窗口调整搞反",
    trapSummary: "遇到三次重复 ACK 时也把 cwnd 直接清回 1，或遇到超时时忘了先将慢开始门限降为当前窗口一半。",
    takeawayRule: "超时先砍半门限再归 1 慢开始；三重复 ACK 砍半门限后从新门限直接快恢复。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "math-calculus-lhopital-form",
    subjectLabel: "高等数学",
    pitfallTitle: "洛必达法则未先判型直接上下求导",
    trapSummary: "看到分式极限就习惯性分子分母同时求导，忽略了代入极限点后并非 0/0 或 ∞/∞ 未定式。",
    takeawayRule: "求极限先代入判型，确认 0/0 或 ∞/∞ 且导数比极限存在再用洛必达。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "math-calculus-substitution-bounds",
    subjectLabel: "高等数学",
    pitfallTitle: "定积分换元后忘记同步更换上下限",
    trapSummary: "被积函数与微分都已经换成新变量 u，积分上下限却仍然沿用原变量 x 的端点数值。",
    takeawayRule: "定积分换元三步同步：换变量、换微分、换上下限，完成后不必回代原变量。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "math-linalg-diagonalizable-multiplicity",
    subjectLabel: "线性代数",
    pitfallTitle: "看到重特征值就默认矩阵一定可对角化",
    trapSummary: "求出特征多项式的根后跳过特征向量个数检查，未验证每个重特征值的几何重数是否等于代数重数。",
    takeawayRule: "有重特征值先算 n - rank(A - λE)，只有每个重根都相等时矩阵才可对角化。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "math-prob-independent-vs-exclusive",
    subjectLabel: "概率论与数理统计",
    pitfallTitle: "把互斥事件和相互独立混为一谈",
    trapSummary: "认为两个事件互不相容就互不影响，把 P(AB) = 0 误套到独立公式 P(AB) = P(A)P(B) 中。",
    takeawayRule: "互斥看交集为空，独立看乘积相等；正概率的互斥事件一定不独立。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "ielts-reading-false-vs-not-given",
    subjectLabel: "雅思阅读",
    pitfallTitle: "把原文明确否定的 False 误判为 Not Given",
    trapSummary: "题干使用了同义改写或反义限定词，扫描原词没找到就直接选 Not Given，漏掉了原文已给出相反结论。",
    takeawayRule: "先核对核心关系词是否与原文直接冲突：冲突选 False，原文未比较或未提及才选 Not Given。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "ielts-writing-task2-overgeneralize",
    subjectLabel: "雅思写作",
    pitfallTitle: "议论文使用绝对化断言导致论证失真",
    trapSummary: "频繁写出 all、always、completely 等无限定结论，使观点缺乏边界条件，容易削弱任务回应说服力。",
    takeawayRule: "下判断前补上适用范围、群体或程度限定词，再用具体因果链支撑分论点。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
  {
    pitfallId: "ielts-listening-distractor-self-correction",
    subjectLabel: "雅思听力",
    pitfallTitle: "听到第一个时间或价格就停笔漏掉自我更正",
    trapSummary: "说话人先报出旧预约或原价，随后用 actually、sorry 或 instead 修正，提前走神直接填入干扰项。",
    takeawayRule: "数字、日期和地点听到第一遍先记草稿，等话轮完全结束确认无转折再定稿。",
    cohortSampleSize: 0,
    cohortTrapRate: null,
  },
];

export const SHAREABLE_PITFALL_CATALOG: readonly ShareablePitfallEntry[] = Object.freeze(
  RAW_SHAREABLE_PITFALL_CATALOG.map((entry) => Object.freeze({ ...entry })),
);

const SHAREABLE_PITFALL_BY_ID: ReadonlyMap<string, ShareablePitfallEntry> = new Map(
  SHAREABLE_PITFALL_CATALOG.map((entry) => [entry.pitfallId, entry]),
);

export function listShareablePitfalls(): readonly ShareablePitfallEntry[] {
  return SHAREABLE_PITFALL_CATALOG;
}

export function getShareablePitfallById(pitfallId: string): ShareablePitfallEntry | null {
  return SHAREABLE_PITFALL_BY_ID.get(pitfallId) ?? null;
}

export function isKnownShareablePitfallId(pitfallId: string): boolean {
  return SHAREABLE_PITFALL_BY_ID.has(pitfallId);
}
