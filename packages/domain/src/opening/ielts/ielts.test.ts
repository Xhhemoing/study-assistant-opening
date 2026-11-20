import { describe, expect, it } from "vitest";
import {
  IELTS_CARTRIDGE_ID,
  analyzeCrossDraftTransfer,
  buildSpeakingPart3Seed,
  computeOverallIeltsBand,
  countDraftWords,
  createValidatedRubricReceipt,
  detectMemorizedTemplates,
  evaluateRevisedDraftDeterministically,
  evaluateSpeakingRetelling,
  isValidIeltsBand,
  type IeltsCriterionAssessment,
  type IeltsEssayDraft,
  type IeltsUpgradeTarget,
} from "./index";

const DRAFT_1: IeltsEssayDraft = {
  draftId: "draft-1",
  version: 1,
  label: "一稿",
  promptId: "urban-rail-funding-v1",
  assisted: false,
  timeSpentSeconds: 2280,
  timeBoxSeconds: 2400,
  createdAt: "2026-11-20T08:00:00.000Z",
  paragraphs: [
    "With the rapid development of modern cities, traffic jams have become a very important problem for people. Some people think governments should build more roads, while others think public transport is better. In my opinion, investing in trains is good for the city.",
    "Firstly, trains can carry many people at the same time. When more commuters take trains instead of driving cars, there will be fewer cars on the road and less pollution in the air. This is very important for big cities with high populations.",
    "On the other hand, building roads is also useful because cars are convenient for families living in the suburbs. However, roads get full quickly when more people buy cars.",
    "In a nutshell, governments should spend more money on public trains rather than wider roads to make city travel easier and cleaner.",
  ],
};

const DRAFT_2: IeltsEssayDraft = {
  draftId: "draft-2",
  version: 2,
  label: "二稿",
  promptId: "urban-rail-funding-v1",
  assisted: false,
  timeSpentSeconds: 2040,
  timeBoxSeconds: 2400,
  createdAt: "2026-11-20T09:15:00.000Z",
  paragraphs: [
    "As metropolitan populations expand rapidly, municipal authorities face a difficult allocation choice between widening road corridors and financing urban rail transit. Although private cars still dominate commuter habits in many regions, I contend that directing public funds toward high-capacity rail offers far greater long-term fiscal viability and environmental relief than continually expanding motorways.",
    "High-capacity rail directly addresses peak-hour bottlenecks because a single electrified corridor can transport tens of thousands of commuters without claiming additional urban land or dividing neighbourhoods. Consequently, shifting daily travel away from private vehicles helps alleviate chronic congestion while lowering per-capita emissions across densely populated districts. Over a twenty-year horizon, predictable transit schedules also anchor commercial productivity and cut municipal road-maintenance costs.",
    "Admittedly, widening arterial roads may deliver immediate convenience for outer-suburban households that currently lack nearby stations or reliable evening services. While expanding motorways can ease localized delays briefly, induced traffic demand typically encourages additional car ownership and longer driving distances, which undermines those short-lived gains within a few years. Pairing core rail lines with frequent feeder buses resolves this suburban gap far more sustainably.",
    "Ultimately, prioritising integrated rail networks alongside reliable feeder services delivers durable mobility benefits that road expansion alone cannot sustain. Governments should therefore anchor transport budgets in mass transit infrastructure rather than short-term highway widening.",
  ],
};

const TARGETS: readonly IeltsUpgradeTarget[] = [
  {
    id: "t-collocation",
    category: "targetCollocations",
    criterion: "LR",
    label: "精准交通与财政搭配",
    targetPatterns: ["alleviate chronic congestion", "per-capita emissions", "long-term fiscal viability"],
    weakBaselinePatterns: ["very important", "good for"],
    clichePatterns: ["with the rapid development of", "every coin has two sides"],
    guidance: "用具体学术搭配替代 very important / good for 等空泛表达。",
  },
  {
    id: "t-syntax",
    category: "syntacticStructures",
    criterion: "GRA",
    label: "让步从句 + 非限定修饰",
    targetPatterns: ["while expanding motorways", "which undermines"],
    guidance: "用 While... 让步从句和 which 非限定定语从句拉升句法层次。",
  },
  {
    id: "t-cohesion",
    category: "cohesiveDevices",
    criterion: "CC",
    label: "自然因果与递进衔接",
    targetPatterns: ["consequently", "therefore"],
    clichePatterns: ["in a nutshell", "last but not least"],
    guidance: "用精准逻辑连接词替代模板收尾。",
  },
  {
    id: "t-counter",
    category: "counterargumentDepth",
    criterion: "TR",
    label: "反方让步与机制拆解（诱发交通需求）",
    targetPatterns: ["admittedly", "induced traffic demand"],
    guidance: "先承认郊区居民便利性，再指出诱发交通需求如何抵消短期扩路收益。",
  },
];

function buildValidDraft2Assessments(): IeltsCriterionAssessment[] {
  return [
    {
      criterion: "TR",
      band: 7.5,
      summary: "立场一贯，反方让步与机制拆解充分。",
      evidenceSpans: [
        {
          id: "tr-1",
          paragraphIndex: 2,
          excerpt: "induced traffic demand typically encourages additional car ownership",
          criterion: "TR",
          diagnosis: "清晰解释了扩路难以长期治堵的因果机制。",
          upgradeRewrite:
            "induced traffic demand typically stimulates further car ownership, eroding temporary gains.",
        },
      ],
    },
    {
      criterion: "CC",
      band: 7,
      summary: "段落主线紧凑，因果指代自然。",
      evidenceSpans: [
        {
          id: "cc-1",
          paragraphIndex: 1,
          excerpt: "Consequently, shifting daily travel away from private vehicles",
          criterion: "CC",
          diagnosis: "因果过渡直接承接前句高运力事实，衔接自然。",
          upgradeRewrite:
            "Consequently, encouraging commuters to shift away from private cars eases peak-hour pressure.",
        },
      ],
    },
    {
      criterion: "LR",
      band: 7.5,
      summary: "学术搭配准确贴题，清除了模板开篇。",
      evidenceSpans: [
        {
          id: "lr-1",
          paragraphIndex: 1,
          excerpt: "alleviate chronic congestion while lowering per-capita emissions",
          criterion: "LR",
          diagnosis: "精准替换了一稿中的 fewer cars / less pollution 泛化表达。",
          upgradeRewrite:
            "alleviate chronic urban congestion while steadily curbing per-capita emissions.",
        },
      ],
    },
    {
      criterion: "GRA",
      band: 7,
      summary: "让步结构与非限定从句控制稳定。",
      evidenceSpans: [
        {
          id: "gra-1",
          paragraphIndex: 2,
          excerpt: "While expanding motorways can ease localized delays briefly",
          criterion: "GRA",
          diagnosis: "让步主从句准确平衡了短期现象与长期后果。",
          upgradeRewrite:
            "While expanding motorways may relieve localized bottlenecks initially, it rarely solves urban gridlock.",
        },
      ],
    },
  ];
}

describe("IELTS rubric validation & band scoring", () => {
  it("validates 4.0-9.0 bands in strict 0.5 steps and applies official IELTS rounding", () => {
    expect(isValidIeltsBand(4)).toBe(true);
    expect(isValidIeltsBand(6.5)).toBe(true);
    expect(isValidIeltsBand(9)).toBe(true);
    expect(isValidIeltsBand(3.5)).toBe(false);
    expect(isValidIeltsBand(9.5)).toBe(false);
    expect(isValidIeltsBand(6.25)).toBe(false);
    expect(isValidIeltsBand(Number.NaN)).toBe(false);

    // Average 6.25 -> rounds up to 6.5
    expect(computeOverallIeltsBand({ TR: 6.5, CC: 6.5, LR: 6, GRA: 6 })).toBe(6.5);
    // Average 6.75 -> rounds up to 7.0
    expect(computeOverallIeltsBand({ TR: 7, CC: 7, LR: 6.5, GRA: 6.5 })).toBe(7);
    // Average 7.25 -> rounds up to 7.5
    expect(computeOverallIeltsBand({ TR: 7.5, CC: 7, LR: 7.5, GRA: 7 })).toBe(7.5);
  });

  it("rejects assessments lacking concrete span-grounded textual evidence", () => {
    const missingSpans = buildValidDraft2Assessments().map((item) =>
      item.criterion === "LR" ? { ...item, evidenceSpans: [] } : item,
    );
    const res1 = createValidatedRubricReceipt({
      receiptId: "r-missing",
      taskMode: "writing_task2",
      draft: DRAFT_2,
      assessments: missingSpans,
      crossDraftTransferVerified: true,
    });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.errors.some((e) => e.code === "MISSING_EVIDENCE_SPANS" && e.criterion === "LR")).toBe(true);
    }

    const fabricatedQuote = buildValidDraft2Assessments().map((item) =>
      item.criterion === "TR"
        ? {
            ...item,
            evidenceSpans: [
              {
                ...item.evidenceSpans[0]!,
                excerpt: "this quote never appeared anywhere in the essay",
              },
            ],
          }
        : item,
    );
    const res2 = createValidatedRubricReceipt({
      receiptId: "r-fabricated",
      taskMode: "writing_task2",
      draft: DRAFT_2,
      assessments: fabricatedQuote,
      crossDraftTransferVerified: true,
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.errors.some((e) => e.code === "EXCERPT_NOT_GROUNDED" && e.criterion === "TR")).toBe(true);
    }
  });

  it("rejects invalid band steps and out-of-range paragraph indices", () => {
    const badAssessments = buildValidDraft2Assessments().map((item) =>
      item.criterion === "GRA"
        ? {
            ...item,
            band: 6.3 as never,
            evidenceSpans: [{ ...item.evidenceSpans[0]!, paragraphIndex: 99 }],
          }
        : item,
    );
    const res = createValidatedRubricReceipt({
      receiptId: "r-bad-band",
      taskMode: "writing_task2",
      draft: DRAFT_2,
      assessments: badAssessments,
      crossDraftTransferVerified: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "INVALID_BAND")).toBe(true);
      expect(res.errors.some((e) => e.code === "PARAGRAPH_OUT_OF_RANGE")).toBe(true);
    }
  });
});

describe("Honest evidence epistemology (practice_feedback vs rubric_verified_evidence)", () => {
  it("keeps single-draft and assisted revisions strictly as practice_feedback", () => {
    const singleDraftResult = evaluateRevisedDraftDeterministically({
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_1,
      targets: TARGETS,
      receiptId: "r-d1",
    });
    expect(singleDraftResult.receipt.epistemicStatus).toBe("practice_feedback");
    expect(singleDraftResult.receipt.countsTowardMastery).toBe(false);

    const assistedDraft2 = { ...DRAFT_2, assisted: true };
    const assistedResult = createValidatedRubricReceipt({
      receiptId: "r-assisted",
      taskMode: "writing_task2",
      draft: assistedDraft2,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: true,
    });
    expect(assistedResult.ok).toBe(true);
    if (assistedResult.ok) {
      expect(assistedResult.receipt.epistemicStatus).toBe("practice_feedback");
      expect(assistedResult.receipt.countsTowardMastery).toBe(false);
    }
  });

  it("blocks formal verification when memorized template stuffing is present", () => {
    const stuffedDraft2: IeltsEssayDraft = {
      ...DRAFT_2,
      paragraphs: [
        `Every coin has two sides. ${DRAFT_2.paragraphs[0]}`,
        ...DRAFT_2.paragraphs.slice(1),
      ],
    };
    const hits = detectMemorizedTemplates(stuffedDraft2.paragraphs);
    expect(hits.some((h) => h.phrase === "every coin has two sides" && h.severity === "blocking")).toBe(true);

    const result = evaluateRevisedDraftDeterministically({
      baselineDraft: DRAFT_1,
      revisedDraft: stuffedDraft2,
      targets: TARGETS,
      receiptId: "r-stuffed",
    });
    expect(result.receipt.epistemicStatus).toBe("practice_feedback");
    expect(result.receipt.countsTowardMastery).toBe(false);
  });

  it("promotes unassisted verified Draft 2 transfer with zero cliché stuffing to rubric_verified_evidence", () => {
    expect(countDraftWords(DRAFT_2.paragraphs)).toBeGreaterThanOrEqual(180);
    const result = createValidatedRubricReceipt({
      receiptId: "r-verified-d2",
      taskMode: "writing_task2",
      draft: DRAFT_2,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.cartridgeId).toBe(IELTS_CARTRIDGE_ID);
      expect(result.receipt.overallBand).toBe(7.5);
      expect(result.receipt.epistemicStatus).toBe("rubric_verified_evidence");
      expect(result.receipt.countsTowardMastery).toBe(true);
      expect(result.receipt.criteria.LR.evidenceSpans[0]?.startOffset).toBeTypeOf("number");
    }
  });

  it("allows unassisted fresh-prompt transfer to qualify as rubric_verified_evidence", () => {
    const freshDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "fresh-1",
      version: 1,
      promptId: "fresh-public-parks-v1",
      assisted: false,
    };
    const result = createValidatedRubricReceipt({
      receiptId: "r-fresh",
      taskMode: "writing_task2",
      draft: freshDraft,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: false,
      freshPromptTransfer: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.epistemicStatus).toBe("rubric_verified_evidence");
      expect(result.receipt.evidenceSource).toBe("unassisted_fresh_prompt_transfer");
      expect(result.receipt.countsTowardMastery).toBe(true);
    }
  });
});

describe("Cross-draft transfer analyzer", () => {
  it("tracks transferred upgrades and paragraph diffs cleanly from Draft 1 to Draft 2", () => {
    const report = analyzeCrossDraftTransfer({
      draft1: DRAFT_1,
      draft2: DRAFT_2,
      targets: TARGETS,
    });
    expect(report.summary.transferredCount).toBe(4);
    expect(report.summary.regressedCount).toBe(0);
    expect(report.summary.memorizedClicheCount).toBe(0);
    expect(report.summary.meetsCrossDraftVerification).toBe(true);
    expect(report.paragraphDiffs).toHaveLength(4);
    expect(report.paragraphDiffs.every((d) => d.status === "revised")).toBe(true);
  });

  it("classifies regressed, memorized_cliche, and pending statuses deterministically", () => {
    const baseWithCounter: IeltsEssayDraft = {
      ...DRAFT_1,
      paragraphs: [
        "Admittedly, induced traffic demand limits road expansion.",
        ...DRAFT_1.paragraphs.slice(1),
      ],
    };
    const poorRevision: IeltsEssayDraft = {
      ...DRAFT_1,
      draftId: "draft-2-poor",
      version: 2,
      paragraphs: [
        "Every coin has two sides when cities debate transport spending.",
        "Trains are useful for daily commuters in large cities.",
        "Cars remain convenient for suburban families.",
        "In a nutshell, cities need balanced transport options.",
      ],
    };

    const report = analyzeCrossDraftTransfer({
      draft1: baseWithCounter,
      draft2: poorRevision,
      targets: TARGETS,
    });

    const byId = Object.fromEntries(report.items.map((i) => [i.targetId, i.status]));
    expect(byId["t-collocation"]).toBe("memorized_cliche");
    expect(byId["t-cohesion"]).toBe("memorized_cliche");
    expect(byId["t-counter"]).toBe("regressed");
    expect(byId["t-syntax"]).toBe("pending");
    expect(report.summary.hasMemorizedStuffing).toBe(true);
    expect(report.summary.meetsCrossDraftVerification).toBe(false);
  });
});

describe("Speaking Part 3 oral transfer seed & feedback", () => {
  it("converts a refined Writing Task 2 argument into a 60-90s Part 3 seed and evaluates oral transfer", () => {
    const seed = buildSpeakingPart3Seed(
      {
        promptId: "urban-rail-funding-v1",
        topic: "urban public transport funding",
        coreClaim: "High-capacity rail delivers stronger long-term urban mobility than widening highways.",
        supportingReason: "Rail moves far more commuters per corridor while cutting per-capita emissions.",
        counterPerspective: "Suburban residents may rely on cars where station density is still low.",
        activeCollocations: [
          "alleviate chronic congestion",
          "per-capita emissions",
          "long-term fiscal viability",
          "Furthermore", // Stiff written connector should be stripped for speech
        ],
      },
      "draft-2",
    );

    expect(seed.timeWindowSeconds).toEqual({ min: 60, max: 90 });
    expect(seed.targetSpokenCollocations).not.toContain("Furthermore");
    expect(seed.targetSpokenCollocations).toContain("alleviate chronic congestion");

    const strongTranscript =
      "Personally, I think governments struggle because voters feel wider roads immediately, whereas urban rail takes years to build. " +
      "That said, investing in mass transit is the only way to alleviate chronic congestion and lower per-capita emissions over the next decade. " +
      "Admittedly, suburban families still rely on cars when stations are far away, which is why feeder buses matter too. " +
      "In the long run, protecting long-term fiscal viability requires funding high-capacity rail rather than endless highway expansion.";

    const verifiedReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: strongTranscript,
      durationSeconds: 76,
      assisted: false,
    });

    expect(verifiedReceipt.paceStatus).toBe("on_target");
    expect(verifiedReceipt.transferredCollocations).toHaveLength(3);
    expect(verifiedReceipt.evidenceSpans.length).toBeGreaterThan(0);
    expect(verifiedReceipt.epistemicStatus).toBe("rubric_verified_evidence");
    expect(verifiedReceipt.countsTowardMastery).toBe(true);

    // Assisted or too-short response must stay practice_feedback
    const assistedReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: strongTranscript,
      durationSeconds: 76,
      assisted: true,
    });
    expect(assistedReceipt.epistemicStatus).toBe("practice_feedback");
    expect(assistedReceipt.countsTowardMastery).toBe(false);

    const shortReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: "I think trains are better because they alleviate chronic congestion.",
      durationSeconds: 32,
      assisted: false,
    });
    expect(shortReceipt.paceStatus).toBe("too_short");
    expect(shortReceipt.epistemicStatus).toBe("practice_feedback");
  });
});
