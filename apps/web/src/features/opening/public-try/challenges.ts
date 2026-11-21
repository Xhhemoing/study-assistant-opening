export const challenges = [
  {
    id: "limit",
    topic: "微积分 · 极限",
    question: "当 x 趋近 0，(1 + 2x) / (2 + x) 的极限是多少？",
    steps: [
      "记分子为 f(x) = 1 + 2x，分母为 g(x) = 2 + x。",
      "在 0 附近，f 和 g 都可导，且 g′(x) = 1。",
      "由洛必达法则，原极限等于 f′(x) / g′(x) 在 0 处的极限。",
      "计算导数之比：f′(x) / g′(x) = 2 / 1 = 2。",
    ],
    reasons: ["先检查原式是否为未定式。", "先确认分子和分母的次数相同。", "求导后还需再对分母求一次导。"],
    brokenStep: 2, correctReason: 0,
    diagnosis: "可导只是条件之一。分子趋近 1，分母趋近 2，这里没有出现 0/0 或 ∞/∞ 型。直接代入就得到 1/2。",
    retest: "换一组常数项，先判断能否直接代入，再决定是否求导。",
  },
  {
    id: "integral",
    topic: "微积分 · 反常积分",
    question: "从 1 到正无穷，对 1/x² 积分，面积有多大？",
    steps: [
      "取 R > 1，先求从 1 到 R 的积分，再令 R 趋近正无穷。",
      "令 u = 1/x，则 du = −dx/x²。",
      "当 x = 1 时，u = 1；当 x = R 时，u = 1/R。",
      "于是这段面积等于从 1 到 R 对 −1 关于 u 的积分。",
    ],
    reasons: ["应先去掉负号，再改变积分变量。", "上限无穷意味着面积一定发散。", "积分限也要换成新变量的值。"],
    brokenStep: 3, correctReason: 2,
    diagnosis: "式子用了 u，上限却沿用了 x 的值 R。新上限应为 1/R，积分得到 1 − 1/R，令 R 趋近正无穷后面积为 1。",
    retest: "把起点改成 2，分别写出两个新端点，再取极限。",
  },
  {
    id: "matrix",
    topic: "线性代数 · 矩阵",
    question: "已知 AB = AC，两个二阶方阵 B 和 C 一定相等吗？",
    steps: [
      "取 A 为对角矩阵，对角线上依次为 1 和 0。",
      "两边相减，得到 AB − AC = 0。",
      "用分配律合并，得到 A(B − C) = 0。",
      "因为 A 不是零矩阵，所以可以消去 A，得到 B = C。",
    ],
    reasons: ["分配律只对可交换矩阵成立。", "左乘必须是单射，才能消去左因子。", "只要左右两边都是方阵就能消去。"],
    brokenStep: 3, correctReason: 1,
    diagnosis: "左乘这个 A 会抹去第二行。B 和 C 的第二行即使不同，乘积也可以相同。对方阵，只有 A 可逆时才能对任意 B、C 作这种消去。",
    retest: "换一个秩为一的矩阵，找出两个不同的列向量，使它们左乘后的结果相同。",
  },
] as const;

export type TryChallenge = (typeof challenges)[number];
export type TryReceipt = { challenge: TryChallenge["id"]; step: number; reason: number };
export const storageKey = "opening:public-try:v1";

export function gradeTry(question: TryChallenge, step: number, reason: number) {
  return { stepCorrect: step === question.brokenStep, reasonCorrect: reason === question.correctReason };
}

export function readTryReceipt(raw: string | null): TryReceipt | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("challenge" in value) || !("step" in value) || !("reason" in value)) return null;
    const { step, reason } = value;
    const question = challenges.find(item => item.id === value.challenge);
    if (!question || typeof step !== "number" || !Number.isInteger(step) || step < 0 || step >= question.steps.length ||
        typeof reason !== "number" || !Number.isInteger(reason) || reason < 0 || reason >= question.reasons.length) return null;
    return { challenge: question.id, step, reason };
  } catch {
    return null;
  }
}
