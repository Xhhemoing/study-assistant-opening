import {
  formatAssetGraphNodeId,
  type AssetGraphEdge,
  type AssetGraphNode,
  type AssetGraphNodeId,
} from "@aistudy/contracts";

// This namespace is exclusively a local sandbox demonstration; it is never sent to the real graph API.
export const SERIES_CHECK_KEY = "aistudy-series-example-comparison-check-v1";

export const SERIES_QUESTIONS = [
  {
    title: "判断不等式方向",
    prompt: "对所有 n ≥ 1，有 0 ≤ aₙ ≤ bₙ，且 Σaₙ 收敛。仅凭这些条件，Σbₙ 怎么样？",
    choices: ["一定收敛", "一定发散", "两种情况都有可能"],
    correct: 2,
    hint: "想一想，一个收敛的下界，能限制更大一项的和吗？",
    why: "取 aₙ = 1/n²。让 bₙ 等于 1/n² 或 1/n，都满足条件，两个级数的敛散性却不同。",
  },
  {
    title: "选择可用的上界",
    prompt: "要用直接比较判别法证明 Σ 1/(n²+n) 收敛，哪个比较对象最合适？",
    choices: [
      "1/n，因为它更大",
      "1/n²，因为它是收敛级数的通项，且足够大",
      "1/n³，因为它衰减得更快",
    ],
    correct: 1,
    hint: "逐项核对两个条件：所选级数要收敛，它的通项还要大于或等于原来的通项。",
    why: "当 n ≥ 1 时，1/(n²+n) ≤ 1/n²，且 Σ 1/n² 收敛。1/n 的和发散，1/n³ 也无法作为对所有充分大 n 都成立的上界。",
  },
] as const;

export type SeriesCheck = {
  answers: number[];
  hints: boolean[];
  reviewed: boolean;
  attached: boolean;
};

export function readSeriesCheck(raw: unknown): SeriesCheck {
  const saved = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const savedAnswers = Array.isArray(saved.answers) ? saved.answers : [];
  const savedHints = Array.isArray(saved.hints) ? saved.hints : [];
  const answers: number[] = [];
  for (let index = 0; index < SERIES_QUESTIONS.length; index++) {
    const choice: unknown = savedAnswers[index];
    if (
      typeof choice !== "number" ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice >= SERIES_QUESTIONS[index]!.choices.length
    ) {
      break;
    }
    answers.push(choice);
  }
  return {
    answers,
    hints: SERIES_QUESTIONS.map((_, index) => savedHints[index] === true),
    reviewed: saved.reviewed === true,
    attached: answers.length === SERIES_QUESTIONS.length && saved.attached === true,
  };
}

export function seriesOutcome(check: SeriesCheck) {
  if (check.answers.length !== SERIES_QUESTIONS.length) return null;
  if (check.answers[0] !== SERIES_QUESTIONS[0].correct) {
    return {
      label: "再辨比较方向",
      summary: "先练方向：分别用一个收敛上界和一个收敛下界，判断各自能推出什么。",
    };
  }
  if (check.answers[1] !== SERIES_QUESTIONS[1].correct) {
    return {
      label: "再练选择上界",
      summary: "下一次先只找比较对象：给候选上界写出「它够大」和「它的和收敛」这两个理由。",
    };
  }
  if (check.hints.some(Boolean)) {
    return {
      label: "换题撤去提示",
      summary: "两步均已答对。下次换一道题，尝试在没有提示的情况下自己写出比较式。",
    };
  }
  return {
    label: "换题说明理由",
    summary: "这两题均在未点提示时答对。下一步用一道新题写出比较式，并解释上界为什么可用。",
  };
}

const exampleUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function id(kind: AssetGraphNode["kind"], n: number): AssetGraphNodeId {
  const uuid = exampleUuid(n);
  return formatAssetGraphNodeId(
    kind === "knowledge" ? { kind, courseId: exampleUuid(1), nodeId: uuid } : { kind, uuid },
  );
}

export const SERIES_ROOT = id("course", 1);
export const SERIES_COMPARISON = id("knowledge", 4);
export const SERIES_MARK = id("document", 13);

type ExampleItem = {
  node: AssetGraphNode;
  parent?: AssetGraphNodeId;
  relation?: AssetGraphEdge["relation"];
  detail: string;
};

const item = (
  n: number,
  label: string,
  detail: string,
  parent?: AssetGraphNodeId,
  kind: AssetGraphNode["kind"] = "knowledge",
  relation: AssetGraphEdge["relation"] = "contains",
): ExampleItem => ({ node: { id: id(kind, n), kind, label }, parent, relation, detail });

const EXAMPLE_ITEMS: ExampleItem[] = [
  item(
    1,
    "数项级数",
    "示例章节，围绕必要条件、p 级数与比较判别法整理。所有连接均为教学示例，不属于你的真实课程。",
    undefined,
    "course",
  ),
  item(
    2,
    "收敛的必要条件",
    "演示历史：曾在纸上复习，上次在提示后才给出反例，独立辨析仍待检验。",
    SERIES_ROOT,
  ),
  item(3, "p 级数", "演示历史：这一轮暂无复习与作答记录。不能据此判断独立表现。", SERIES_ROOT),
  item(
    4,
    "比较判别法",
    "演示历史：上周独立做对一道题。本轮纸上复习与下面这两道示例题的作答分别记录。",
    SERIES_ROOT,
  ),
  item(
    5,
    "调和级数",
    "Σ 1/n 发散。通项趋零不足以推出级数收敛。",
    id("knowledge", 2),
    "knowledge",
    "linkedTo",
  ),
  item(
    6,
    "平方倒数级数",
    "Σ 1/n² 收敛。与调和级数对照，辨清必要条件的局限。",
    id("knowledge", 2),
    "knowledge",
    "linkedTo",
  ),
  item(
    7,
    "临界值 p = 1",
    "对从 n = 1 开始的 Σ 1/nᵖ，p > 1 时收敛，p ≤ 1 时发散。",
    id("knowledge", 3),
  ),
  item(
    8,
    "不等式方向",
    "对于充分大的 n，若 0 ≤ aₙ ≤ bₙ 且 Σbₙ 收敛，则 Σaₙ 收敛。",
    SERIES_COMPARISON,
  ),
  item(
    9,
    "课堂讲义（示例）",
    "示例讲义第 3 版第 12 页：收敛级数的相邻部分和之差趋于零。",
    id("knowledge", 2),
    "source",
    "usesSource",
  ),
  item(
    10,
    "上次作答（示例）",
    "演示作答：得到「试试调和级数」的提示后才完成判断。",
    id("knowledge", 2),
    "observation",
    "hasObservation",
  ),
  item(
    11,
    "积分判别",
    "对正且最终单调递减的函数，可用对应反常积分判断敛散。",
    id("knowledge", 3),
    "knowledge",
    "linkedTo",
  ),
  item(
    12,
    "几何级数",
    "当 |r| < 1 时几何级数收敛，合适的几何上界可用于比较。",
    SERIES_COMPARISON,
    "knowledge",
    "linkedTo",
  ),
];

export function seriesExampleGraph(check: SeriesCheck) {
  const outcome = seriesOutcome(check);
  const nodes = EXAMPLE_ITEMS.map<AssetGraphNode>(({ node }) => {
    if (node.id === id("knowledge", 2)) {
      return { ...node, summary: { learnerState: "hinted", requirementStatus: null } };
    }
    if (node.id === SERIES_COMPARISON) {
      return {
        ...node,
        summary: {
          learnerState: outcome
            ? check.answers.some((answer, index) => answer !== SERIES_QUESTIONS[index]!.correct)
              ? "retest"
              : check.hints.some(Boolean)
                ? "hinted"
                : "independent"
            : "independent",
          requirementStatus: null,
        },
      };
    }
    if (node.kind === "source") return { ...node, meta: { version: 3 } };
    if (node.kind === "observation") return { ...node, meta: { assistance: "hinted" } };
    return { ...node };
  });
  const edges: AssetGraphEdge[] = EXAMPLE_ITEMS.filter(entry => entry.parent).map(entry => ({
    id: `series-example:${entry.parent}:${entry.node.id}`,
    from: entry.parent!,
    to: entry.node.id,
    relation: entry.relation!,
    basis: "recorded",
    ...(entry.relation === "contains" ? { knowledgeStatus: "supported" as const } : {}),
    ...(entry.node.kind === "source" ? { sourceVersion: 3, page: 12 } : {}),
  }));
  if (check.attached && outcome) {
    nodes.push({ id: SERIES_MARK, kind: "document", label: outcome.label });
    edges.push({
      id: "series-example:personal-mark",
      from: SERIES_COMPARISON,
      to: SERIES_MARK,
      relation: "linkedTo",
      basis: "recorded",
    });
  }
  return { nodes, edges };
}

export function seriesExampleDetail(nodeId: string, check: SeriesCheck) {
  return nodeId === SERIES_MARK
    ? seriesOutcome(check)?.summary
    : EXAMPLE_ITEMS.find(entry => entry.node.id === nodeId)?.detail;
}
