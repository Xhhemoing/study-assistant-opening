import {
  analyzeCrossDraftTransfer,
  buildSpeakingPart3Seed,
  createValidatedRubricReceipt,
  evaluateSpeakingRetelling,
  type IeltsCriterionAssessment,
  type IeltsCrossDraftTransferReport,
  type IeltsEssayDraft,
  type IeltsRubricReceipt,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPart3Seed,
  type IeltsUpgradeTarget,
  type IeltsWritingCoreArgument,
} from "./domain-bridge";

export type IeltsWorkbenchFixture = {
  readonly promptId: string;
  readonly promptTitleZh: string;
  readonly promptStatementEn: string;
  readonly promptTaskTypeLabel: string;
  readonly targetWordCount: number;
  readonly draft1: IeltsEssayDraft;
  readonly draft2: IeltsEssayDraft;
  readonly draft1Receipt: IeltsRubricReceipt;
  readonly draft2Receipt: IeltsRubricReceipt;
  readonly targets: readonly IeltsUpgradeTarget[];
  readonly transferReport: IeltsCrossDraftTransferReport;
  readonly coreArgument: IeltsWritingCoreArgument;
  readonly speakingSeed: IeltsSpeakingPart3Seed;
  readonly initialSpeakingTranscript: string;
  readonly initialSpeakingDurationSeconds: number;
  readonly initialSpeakingReceipt: IeltsSpeakingFeedbackReceipt;
};

const PROMPT_ID = "ielts-task2-urban-rail-funding";

const DRAFT_1: IeltsEssayDraft = {
  draftId: "urban-rail-draft-1",
  version: 1,
  label: "一稿",
  promptId: PROMPT_ID,
  assisted: false,
  timeSpentSeconds: 2280,
  timeBoxSeconds: 2400,
  createdAt: "2026-11-20T08:05:00.000Z",
  paragraphs: [
    "With the rapid development of modern cities, traffic jams have become a very important problem for citizens. Some people argue that governments should build wider roads, while others believe investing in public trains is better. In my opinion, spending public money on rail transport is good for urban development.",
    "Firstly, trains can move many commuters at the same time during rush hour. When more people choose trains instead of driving private cars, there will be fewer cars on the streets and less air pollution. This is very important for crowded cities that want cleaner air and faster travel.",
    "On the other hand, expanding roads is also helpful for families living in outer suburbs where stations are far away. However, wider roads often get full again quickly when more residents decide to buy cars.",
    "In a nutshell, governments should spend more of the transport budget on urban rail rather than highways so that commuting becomes easier and greener in the future.",
  ],
};

const DRAFT_2: IeltsEssayDraft = {
  draftId: "urban-rail-draft-2",
  version: 2,
  label: "二稿",
  promptId: PROMPT_ID,
  assisted: false,
  timeSpentSeconds: 2040,
  timeBoxSeconds: 2400,
  createdAt: "2026-11-20T09:20:00.000Z",
  paragraphs: [
    "As metropolitan populations expand rapidly, municipal authorities face a difficult allocation choice between widening road corridors and financing urban rail transit. Although private cars still dominate commuter habits in many regions, I contend that directing public funds toward high-capacity rail offers far greater long-term fiscal viability and environmental relief than continually expanding motorways.",
    "High-capacity rail directly addresses peak-hour bottlenecks because a single electrified corridor can transport tens of thousands of commuters without claiming additional urban land or dividing neighbourhoods. Consequently, shifting daily travel away from private vehicles helps alleviate chronic congestion while lowering per-capita emissions across densely populated districts. Over a twenty-year horizon, predictable transit schedules also anchor commercial productivity and cut municipal road-maintenance costs.",
    "Admittedly, widening arterial roads may deliver immediate convenience for outer-suburban households that currently lack nearby stations or reliable evening services. While expanding motorways can ease localized delays briefly, induced traffic demand typically encourages additional car ownership and longer driving distances, which undermines those short-lived gains within a few years. Pairing core rail lines with frequent feeder buses resolves this suburban gap far more sustainably.",
    "Ultimately, prioritising integrated rail networks alongside reliable feeder services delivers durable mobility benefits that road expansion alone cannot sustain. Governments should therefore anchor transport budgets in mass transit infrastructure rather than short-term highway widening.",
  ],
};

const UPGRADE_TARGETS: readonly IeltsUpgradeTarget[] = [
  {
    id: "ielts-target-collocations",
    category: "targetCollocations",
    criterion: "LR",
    label: "精准城市交通与财政学术搭配",
    targetPatterns: [
      "alleviate chronic congestion",
      "per-capita emissions",
      "long-term fiscal viability",
    ],
    weakBaselinePatterns: ["very important", "good for"],
    clichePatterns: ["with the rapid development of", "every coin has two sides"],
    guidance: "替换一稿中 very important / good for 等笼统词，改用贴合城市基建语境的精准搭配。",
  },
  {
    id: "ielts-target-syntax",
    category: "syntacticStructures",
    criterion: "GRA",
    label: "让步从句与非限定定语从句",
    targetPatterns: ["while expanding motorways", "which undermines"],
    guidance: "通过 While... 让步从句承接短期现实，再用 which 非限定定语从句点出长期副作用。",
  },
  {
    id: "ielts-target-cohesion",
    category: "cohesiveDevices",
    criterion: "CC",
    label: "因果回指与正式收束衔接",
    targetPatterns: ["consequently", "ultimately", "therefore"],
    clichePatterns: ["in a nutshell", "last but not least"],
    guidance: "用 Consequently / Ultimately 替代偏口语的 In a nutshell，让论证推进更克制。",
  },
  {
    id: "ielts-target-counterargument",
    category: "counterargumentDepth",
    criterion: "TR",
    label: "反方让步与机制拆解（诱发交通需求）",
    targetPatterns: ["admittedly", "induced traffic demand", "feeder buses"],
    guidance: "先具体承认郊区通勤痛点，再用诱发交通需求与接驳巴士方案完成反驳闭环。",
  },
];

const DRAFT_1_ASSESSMENTS: readonly IeltsCriterionAssessment[] = [
  {
    criterion: "TR",
    band: 6,
    summary: "立场清楚但反方段偏简略，未解释道路再次拥堵的背后机制。",
    evidenceSpans: [
      {
        id: "d1-tr-1",
        paragraphIndex: 2,
        excerpt: "wider roads often get full again quickly when more residents decide to buy cars",
        criterion: "TR",
        diagnosis: "触及了关键直觉，但缺乏机制化表达与对郊区接驳缺口的回应方案。",
        upgradeRewrite:
          "induced traffic demand typically encourages additional car ownership, which undermines short-lived congestion relief within a few years.",
      },
    ],
  },
  {
    criterion: "CC",
    band: 6,
    summary: "分段合理，但结尾使用偏口语套语，段间逻辑张力偏弱。",
    evidenceSpans: [
      {
        id: "d1-cc-1",
        paragraphIndex: 3,
        excerpt: "In a nutshell, governments should spend more of the transport budget on urban rail",
        criterion: "CC",
        diagnosis: "In a nutshell 偏口语化，在学术议论文收束处会削弱语域正式感。",
        upgradeRewrite:
          "Ultimately, prioritising integrated rail networks alongside reliable feeder services delivers durable mobility benefits.",
      },
    ],
  },
  {
    criterion: "LR",
    band: 5.5,
    summary: "开头落入高频模板套话，正文重复出现 very important / good for。",
    evidenceSpans: [
      {
        id: "d1-lr-1",
        paragraphIndex: 0,
        excerpt: "With the rapid development of modern cities, traffic jams have become a very important problem",
        criterion: "LR",
        diagnosis: "套话开头 + 泛化形容词（very important）会直接拉低词汇地道度。",
        upgradeRewrite:
          "As metropolitan populations expand rapidly, municipal authorities face a difficult allocation choice between widening road corridors and financing urban rail transit.",
      },
    ],
  },
  {
    criterion: "GRA",
    band: 6,
    summary: "基础主从句准确，但句式节奏偏平，缺少精准让步与嵌套修饰。",
    evidenceSpans: [
      {
        id: "d1-gra-1",
        paragraphIndex: 1,
        excerpt: "When more people choose trains instead of driving private cars, there will be fewer cars",
        criterion: "GRA",
        diagnosis: "there will be 句式较平直，改用动名词主语 + 动词搭配能显著压缩冗余词。",
        upgradeRewrite:
          "Consequently, shifting daily travel away from private vehicles helps alleviate chronic congestion while lowering per-capita emissions.",
      },
    ],
  },
];

const DRAFT_2_ASSESSMENTS: readonly IeltsCriterionAssessment[] = [
  {
    criterion: "TR",
    band: 7.5,
    summary: "全程紧扣公共预算分配权衡，反方让步与接驳补救方案完整自洽。",
    evidenceSpans: [
      {
        id: "d2-tr-1",
        paragraphIndex: 2,
        excerpt: "induced traffic demand typically encourages additional car ownership and longer driving distances",
        criterion: "TR",
        diagnosis: "把一稿的直觉升级为可解释的交通经济学机制，并紧接给出接驳巴士方案。",
        upgradeRewrite:
          "Pairing core rail lines with frequent feeder buses directly resolves outer-suburban gaps without triggering further car dependence.",
      },
    ],
  },
  {
    criterion: "CC",
    band: 7,
    summary: "因果过渡与段尾回扣紧密，整体阅读阻力低且不依赖机械序数词。",
    evidenceSpans: [
      {
        id: "d2-cc-1",
        paragraphIndex: 1,
        excerpt: "Consequently, shifting daily travel away from private vehicles helps alleviate chronic congestion",
        criterion: "CC",
        diagnosis: "直接承接前句高运力事实，形成清晰因果链条，替代了机械的 Firstly / Secondly。",
        upgradeRewrite:
          "Consequently, shifting daily travel away from private vehicles eases peak-hour congestion while stabilizing municipal maintenance budgets.",
      },
    ],
  },
  {
    criterion: "LR",
    band: 7.5,
    summary: "已完全清除模板开篇，三组核心学术搭配均准确落地且语域统一。",
    evidenceSpans: [
      {
        id: "d2-lr-1",
        paragraphIndex: 0,
        excerpt: "offers far greater long-term fiscal viability and environmental relief",
        criterion: "LR",
        diagnosis: "精准替换了一稿的 good for urban development，直接对齐公共预算语境。",
        upgradeRewrite:
          "offers stronger long-term fiscal viability and measurable environmental relief than continually expanding motorways.",
      },
      {
        id: "d2-lr-2",
        paragraphIndex: 1,
        excerpt: "alleviate chronic congestion while lowering per-capita emissions",
        criterion: "LR",
        diagnosis: "高频动宾与名词搭配准确自然，避免泛化重复。",
        upgradeRewrite:
          "alleviate chronic congestion while steadily curbing per-capita emissions across dense urban corridors.",
      },
    ],
  },
  {
    criterion: "GRA",
    band: 7,
    summary: "让步从句与非限定修饰运用稳健，长短句交替控制良好。",
    evidenceSpans: [
      {
        id: "d2-gra-1",
        paragraphIndex: 2,
        excerpt: "While expanding motorways can ease localized delays briefly, induced traffic demand typically encourages additional car ownership and longer driving distances, which undermines those short-lived gains within a few years.",
        criterion: "GRA",
        diagnosis: "让步状语从句与非限定定语从句自然复合，准确区分了短期缓解与长期反噬。",
        upgradeRewrite:
          "While expanding motorways may ease localized bottlenecks briefly, induced demand soon draws extra vehicles onto the network, undermining those short-lived gains.",
      },
    ],
  },
];

function mustValidateReceipt(
  receiptId: string,
  draft: IeltsEssayDraft,
  assessments: readonly IeltsCriterionAssessment[],
  crossDraftTransferVerified: boolean,
): IeltsRubricReceipt {
  const result = createValidatedRubricReceipt({
    receiptId,
    taskMode: "writing_task2",
    draft,
    baselineDraft: DRAFT_1,
    assessments,
    crossDraftTransferVerified,
  });
  if (!result.ok) {
    throw new Error(
      `IELTS fixture receipt (${receiptId}) failed validation: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return result.receipt;
}

const TRANSFER_REPORT = analyzeCrossDraftTransfer({
  draft1: DRAFT_1,
  draft2: DRAFT_2,
  targets: UPGRADE_TARGETS,
});

const CORE_ARGUMENT: IeltsWritingCoreArgument = {
  promptId: PROMPT_ID,
  topic: "urban public transport funding",
  coreClaim: "优先投资高运力城市轨道交通，比持续拓宽公路更具长期财政与环境收益。",
  supportingReason: "轨道交通能在不吞噬更多城市土地的前提下缓解高峰拥堵并降低人均排放。",
  counterPerspective: "远郊居民短期内仍依赖私家车，需要高频接驳巴士来补齐最后一公里。",
  activeCollocations: [
    "alleviate chronic congestion",
    "per-capita emissions",
    "long-term fiscal viability",
    "induced traffic demand",
    "feeder buses",
  ],
};

const SPEAKING_SEED = buildSpeakingPart3Seed(CORE_ARGUMENT, DRAFT_2.draftId);

const INITIAL_SPEAKING_TRANSCRIPT =
  "Personally, I think governments struggle because drivers notice a wider highway almost immediately, whereas a new rail line takes years of disruption before anyone can ride it. " +
  "That said, pouring money into urban rail is the only realistic way to alleviate chronic congestion and cut per-capita emissions as cities grow denser. " +
  "Admittedly, people living in outer suburbs still rely on cars when stations are far away, so authorities have to pair rail corridors with reliable feeder buses. " +
  "In the long run, protecting long-term fiscal viability means backing high-capacity transit rather than chasing short-term road expansion that only triggers induced traffic demand.";

const INITIAL_SPEAKING_DURATION = 78;

const INITIAL_SPEAKING_RECEIPT = evaluateSpeakingRetelling({
  seed: SPEAKING_SEED,
  transcript: INITIAL_SPEAKING_TRANSCRIPT,
  durationSeconds: INITIAL_SPEAKING_DURATION,
  assisted: false,
  createdAt: "2026-11-20T09:35:00.000Z",
});

export const IELTS_WRITING_SPEAKING_FIXTURE: IeltsWorkbenchFixture = {
  promptId: PROMPT_ID,
  promptTitleZh: "城市公共预算：优先投资轨道交通，还是继续拓宽公路？",
  promptStatementEn:
    "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
  promptTaskTypeLabel: "Academic Writing Task 2 · 观点论证",
  targetWordCount: 250,
  draft1: DRAFT_1,
  draft2: DRAFT_2,
  draft1Receipt: mustValidateReceipt("receipt-d1", DRAFT_1, DRAFT_1_ASSESSMENTS, false),
  draft2Receipt: mustValidateReceipt(
    "receipt-d2",
    DRAFT_2,
    DRAFT_2_ASSESSMENTS,
    TRANSFER_REPORT.summary.meetsCrossDraftVerification,
  ),
  targets: UPGRADE_TARGETS,
  transferReport: TRANSFER_REPORT,
  coreArgument: CORE_ARGUMENT,
  speakingSeed: SPEAKING_SEED,
  initialSpeakingTranscript: INITIAL_SPEAKING_TRANSCRIPT,
  initialSpeakingDurationSeconds: INITIAL_SPEAKING_DURATION,
  initialSpeakingReceipt: INITIAL_SPEAKING_RECEIPT,
};
