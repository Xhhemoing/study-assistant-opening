import { describe, expect, it, vi } from "vitest";
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
  hasMemorizedTemplateStuffing,
  isValidIeltsBand,
  locateGroundedExcerpt,
  type EvaluateRevisedDraftInput,
  type IeltsCriterionAssessment,
  type IeltsEssayDraft,
  type IeltsUpgradeTarget,
} from "./index";
import { segmentIeltsText } from "./text-segments";

function evaluateNonEmptyRevision(input: EvaluateRevisedDraftInput) {
  const result = evaluateRevisedDraftDeterministically(input);
  if (!result.ok) throw new Error("Expected a Writing receipt for a non-empty revision");
  return result;
}

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

    expect(computeOverallIeltsBand({ TR: 6.5, CC: 6.5, LR: 6, GRA: 6 })).toBe(6.5);
    expect(computeOverallIeltsBand({ TR: 7, CC: 7, LR: 6.5, GRA: 6.5 })).toBe(7);
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

  it("preserves exact UTF-16 slice offsets across Unicode case-expanding characters (İstanbul), surrogate pairs (😀), and Greek final sigma (ΟΔΥΣΣΕΎΣ <-> οδυσσεύς)", () => {
    const emojiIstanbul = "😀 İstanbul";
    const emojiLoc = locateGroundedExcerpt(emojiIstanbul, "i\u0307stanbul");
    expect(emojiLoc).not.toBeNull();
    expect(emojiLoc!.startOffset).toBe(3);
    expect(emojiLoc!.endOffset).toBe(11);
    expect(emojiIstanbul.slice(emojiLoc!.startOffset, emojiLoc!.endOffset)).toBe(
      "İstanbul",
    );
    expect(emojiLoc!.matchedText).toBe("İstanbul");

    const dottedVsAscii = "Istanbul and İstanbul";
    const dottedLoc = locateGroundedExcerpt(dottedVsAscii, "i\u0307stanbul");
    expect(dottedLoc).not.toBeNull();
    expect(dottedLoc!.startOffset).toBe(13);
    expect(dottedLoc!.endOffset).toBe(21);
    expect(dottedVsAscii.slice(dottedLoc!.startOffset, dottedLoc!.endOffset)).toBe(
      "İstanbul",
    );
    expect(dottedLoc!.matchedText).toBe("İstanbul");

    const greekUpper = "ΟΔΥΣΣΕΎΣ";
    const greekLoc = locateGroundedExcerpt(greekUpper, "οδυσσεύς");
    expect(greekLoc).not.toBeNull();
    expect(greekLoc!.startOffset).toBe(0);
    expect(greekLoc!.endOffset).toBe(8);
    expect(greekUpper.slice(greekLoc!.startOffset, greekLoc!.endOffset)).toBe(
      "ΟΔΥΣΣΕΎΣ",
    );
    expect(greekLoc!.matchedText).toBe("ΟΔΥΣΣΕΎΣ");

    const paragraph =
      "İstanbul planners expanded rail corridors to ALLEVIATE CHRONIC CONGESTION across dense districts.";
    const loc = locateGroundedExcerpt(paragraph, "alleviate chronic congestion");
    expect(loc).not.toBeNull();
    expect(paragraph.slice(loc!.startOffset, loc!.endOffset)).toBe(
      "ALLEVIATE CHRONIC CONGESTION",
    );
    expect(loc!.matchedText).toBe("ALLEVIATE CHRONIC CONGESTION");

    // Verify receipt validation stores exact UTF-16 offsets with zero drift.
    const istanbulDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      paragraphs: [
        `😀 İstanbul and ${DRAFT_2.paragraphs[0]}`,
        ...DRAFT_2.paragraphs.slice(1),
      ],
    };
    const assessments = buildValidDraft2Assessments().map((a) =>
      a.criterion === "LR"
        ? {
            ...a,
            evidenceSpans: [
              {
                ...a.evidenceSpans[0]!,
                paragraphIndex: 0,
                excerpt: "LONG-TERM FISCAL VIABILITY",
              },
            ],
          }
        : a,
    );
    const validated = createValidatedRubricReceipt({
      receiptId: "r-istanbul",
      taskMode: "writing_task2",
      draft: istanbulDraft,
      assessments,
      crossDraftTransferVerified: true,
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      const span = validated.receipt.criteria.LR.evidenceSpans[0]!;
      expect(
        istanbulDraft.paragraphs[0]!.slice(span.startOffset, span.endOffset),
      ).toBe(span.excerpt);
      expect(span.excerpt.toLowerCase()).toBe("long-term fiscal viability");
    }
  });

  it("counts repeated warning-level memorized templates within the same paragraph and triggers stuffing gate", () => {
    const doubleTemplateParagraph =
      "In a nutshell, urban rail is efficient. In a nutshell, cities should avoid endless highway widening.";
    const hits = detectMemorizedTemplates([doubleTemplateParagraph]);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.phrase === "in a nutshell" && h.paragraphIndex === 0)).toBe(true);
    expect(hits[0]!.startOffset).not.toBe(hits[1]!.startOffset);
    expect(hasMemorizedTemplateStuffing(hits)).toBe(true);

    const stuffedDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      paragraphs: [
        ...DRAFT_2.paragraphs.slice(0, 3),
        `${DRAFT_2.paragraphs[3]} In a nutshell, rail wins. In a nutshell, roads fail.`,
      ],
    };
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: stuffedDraft,
      targets: TARGETS,
      receiptId: "r-double-template",
    });
    expect(evaluated.receipt.memorizedTemplateFlags.length).toBeGreaterThanOrEqual(2);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.countsTowardMastery).toBe(false);
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

describe("Honest evidence epistemology & Writing anti-gaming transfer guards", () => {
  it("keeps single-draft and assisted revisions strictly as practice_feedback", () => {
    const singleDraftResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_1,
      targets: TARGETS,
      receiptId: "r-d1",
    });
    expect(singleDraftResult.receipt.epistemicStatus).toBe("practice_feedback");
    expect(singleDraftResult.receipt.masteryQualified).toBe(false);
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
      expect(assistedResult.receipt.masteryQualified).toBe(false);
    }
  });

  it("blocks identical resubmission (no substantive revision) from mastery qualification", () => {
    const identicalV2: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-copy",
      version: 2,
    };
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_2,
      revisedDraft: identicalV2,
      targets: TARGETS,
      receiptId: "r-identical",
    });
    expect(evaluated.transferReport.summary.hasSubstantiveRevision).toBe(false);
    expect(evaluated.transferReport.summary.masteryQualified).toBe(false);
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks punctuation-swap plus 12 appended unrelated nouns from bypassing substantive revision or crediting unchanged targets", () => {
    const punctuationSwappedDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-punct-swap",
      version: 2,
      paragraphs: [
        ...DRAFT_2.paragraphs.slice(0, 3).map((p) => p.replaceAll(".", "!")),
        `${DRAFT_2.paragraphs[3]!.replaceAll(".", "!")} Orchestra lantern glacier apricot compass velvet harbor mineral lantern walnut marble cactus pelican.`,
      ],
    };

    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_2,
      revisedDraft: punctuationSwappedDraft,
      targets: TARGETS,
      receiptId: "r-punct-swap",
    });
    expect(evaluated.transferReport.summary.hasSubstantiveRevision).toBe(false);
    expect(evaluated.transferReport.summary.transferredCount).toBe(0);
    expect(evaluated.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(evaluated.transferReport.summary.masteryQualified).toBe(false);
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.countsTowardMastery).toBe(false);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks colon-appended 4-noun suffixes on unchanged DRAFT_2 sentences (and comma-attached variants) from earning transfer credit or mastery", () => {
    const colonSuffixDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-colon-suffix",
      version: 2,
      paragraphs: [
        DRAFT_2.paragraphs[0]!,
        DRAFT_2.paragraphs[1]!.replace(
          "densely populated districts.",
          "densely populated districts: orchard, lantern, glacier, compass.",
        ),
        DRAFT_2.paragraphs[2]!.replace(
          "reliable evening services.",
          "reliable evening services: apricot, marble, pelican, velvet.",
        ),
        DRAFT_2.paragraphs[3]!.replace(
          "short-term highway widening.",
          "short-term highway widening: walnut, cactus, harbor, mineral.",
        ),
      ],
    };

    const colonResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_2,
      revisedDraft: colonSuffixDraft,
      targets: TARGETS,
      receiptId: "r-colon-suffix",
    });
    expect(colonResult.transferReport.summary.hasSubstantiveRevision).toBe(false);
    expect(colonResult.transferReport.summary.transferredCount).toBe(0);
    expect(colonResult.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(colonResult.transferReport.summary.masteryQualified).toBe(false);
    expect(colonResult.receipt.masteryQualified).toBe(false);
    expect(colonResult.receipt.countsTowardMastery).toBe(false);
    expect(colonResult.receipt.epistemicStatus).toBe("practice_feedback");

    // Comma-attached noun tail variant on unchanged sentences must also be blocked.
    const commaSuffixDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-comma-suffix",
      version: 2,
      paragraphs: [
        DRAFT_2.paragraphs[0]!,
        DRAFT_2.paragraphs[1]!.replace(
          "densely populated districts.",
          "densely populated districts, orchard, lantern, glacier, compass.",
        ),
        DRAFT_2.paragraphs[2]!.replace(
          "reliable evening services.",
          "reliable evening services, apricot, marble, pelican, velvet.",
        ),
        DRAFT_2.paragraphs[3]!.replace(
          "short-term highway widening.",
          "short-term highway widening, walnut, cactus, harbor, mineral.",
        ),
      ],
    };

    const commaResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_2,
      revisedDraft: commaSuffixDraft,
      targets: TARGETS,
      receiptId: "r-comma-suffix",
    });
    expect(commaResult.transferReport.summary.hasSubstantiveRevision).toBe(false);
    expect(commaResult.transferReport.summary.transferredCount).toBe(0);
    expect(commaResult.transferReport.summary.masteryQualified).toBe(false);
    expect(commaResult.receipt.masteryQualified).toBe(false);
    expect(commaResult.receipt.countsTowardMastery).toBe(false);
  });

  it("blocks comma-list noun tail padding on unchanged short (<6 word) baseline clauses", () => {
    const shortBaseline: IeltsEssayDraft = {
      ...DRAFT_1,
      draftId: "draft-short-base",
      version: 1,
      paragraphs: [
        "Rail can alleviate chronic congestion.",
        "Transit lowers per-capita emissions.",
        "Admittedly, cars remain convenient.",
        "Governments should therefore fund rail.",
      ],
    };
    const shortPaddedRevision: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-short-padded",
      version: 2,
      paragraphs: [
        "Rail can alleviate chronic congestion, orchard, lantern, glacier, compass.",
        "Transit lowers per-capita emissions, apricot, marble, pelican, velvet.",
        "Admittedly, cars remain convenient, walnut, cactus, harbor, mineral.",
        "Governments should therefore fund rail, meadow, summit, cedar, pebble.",
      ],
    };

    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: shortBaseline,
      revisedDraft: shortPaddedRevision,
      targets: TARGETS,
      receiptId: "r-short-comma-pad",
    });
    expect(evaluated.transferReport.summary.hasSubstantiveRevision).toBe(false);
    expect(evaluated.transferReport.summary.transferredCount).toBe(0);
    expect(evaluated.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(evaluated.transferReport.summary.masteryQualified).toBe(false);
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.countsTowardMastery).toBe(false);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks empty targetExpressions list from qualifying as verified transfer", () => {
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_2,
      targets: [],
      receiptId: "r-empty-targets",
    });
    expect(evaluated.transferReport.summary.totalTargets).toBe(0);
    expect(evaluated.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(evaluated.transferReport.summary.masteryQualified).toBe(false);
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks low-entropy repetitive filler + mechanical keyword pasting at the end of a draft", () => {
    const gamedDraft: IeltsEssayDraft = {
      ...DRAFT_1,
      draftId: "draft-2-gamed",
      version: 2,
      paragraphs: [
        "Traffic in cities is challenging for daily travellers and local planners.",
        "Trains carry commuters efficiently during busy weekday mornings and evenings.",
        "Buses and roads still play a supporting role for families in outer suburbs.",
        "Urban city transport policy matters. Urban city transport policy matters. Urban city transport policy matters. " +
          "Alleviate chronic congestion, per-capita emissions, long-term fiscal viability, while expanding motorways, which undermines, consequently, therefore, admittedly, induced traffic demand.",
      ],
    };

    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: gamedDraft,
      targets: TARGETS,
      receiptId: "r-gamed",
    });
    expect(
      evaluated.transferReport.summary.hasLowEntropyStuffing ||
        evaluated.transferReport.summary.hasMechanicalKeywordPaste,
    ).toBe(true);
    expect(evaluated.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(evaluated.transferReport.summary.masteryQualified).toBe(false);
    expect(evaluated.receipt.masteryQualified).toBe(false);
    expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("promotes unassisted verified Draft 2 transfer with zero cliché stuffing to rubric_verified_evidence", () => {
    expect(countDraftWords(DRAFT_2.paragraphs)).toBeGreaterThanOrEqual(180);
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_2,
      targets: TARGETS,
      receiptId: "r-verified-d2",
    });
    expect(evaluated.transferReport.summary.hasSubstantiveRevision).toBe(true);
    expect(evaluated.transferReport.summary.hasLowEntropyStuffing).toBe(false);
    expect(evaluated.transferReport.summary.hasMechanicalKeywordPaste).toBe(false);
    expect(evaluated.transferReport.summary.meetsCrossDraftVerification).toBe(true);
    expect(evaluated.receipt.cartridgeId).toBe(IELTS_CARTRIDGE_ID);
    expect(evaluated.receipt.epistemicStatus).toBe("rubric_verified_evidence");
    expect(evaluated.receipt.masteryQualified).toBe(true);
    expect(evaluated.receipt.countsTowardMastery).toBe(true);
  });

  it("classifies regressed, memorized_cliche, and pending statuses deterministically", () => {
    const baseWithCounter: IeltsEssayDraft = {
      ...DRAFT_1,
      paragraphs: [
        "Admittedly, induced traffic demand limits road expansion across growing districts.",
        ...DRAFT_1.paragraphs.slice(1),
      ],
    };
    const poorRevision: IeltsEssayDraft = {
      ...DRAFT_1,
      draftId: "draft-2-poor",
      version: 2,
      paragraphs: [
        "Every coin has two sides when metropolitan councils debate transport spending.",
        "Commuter trains carry passengers reliably during busy weekday rush hours.",
        "Private cars remain convenient for families living in low-density suburbs.",
        "In a nutshell, municipal governments should balance diverse mobility options.",
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

describe("Speaking Part 3 oral transfer seed, strict verification gates & Unicode sentence alignment", () => {
  const baseSeed = buildSpeakingPart3Seed(
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
        "Furthermore",
      ],
    },
    "draft-2",
  );

  const strongTranscript =
    "İstanbul is a great example of why governments struggle when voters feel wider roads immediately, whereas urban rail takes years to build. " +
    "People naturally appreciate quick road repairs during election cycles. " +
    "That said, investing in mass transit is the only way to alleviate chronic congestion and lower per-capita emissions over the next decade. " +
    "Admittedly, suburban families still rely on cars when stations are far away, which is why feeder buses matter too. " +
    "In the long run, protecting long-term fiscal viability requires funding high-capacity rail rather than endless highway expansion.";

  it("strips stiff written connectors, aligns lexical quote to the exact matching sentence after İstanbul, and never fabricates official Band", () => {
    expect(baseSeed.timeWindowSeconds).toEqual({ min: 60, max: 90 });
    expect(baseSeed.targetSpokenCollocations).not.toContain("Furthermore");
    expect(baseSeed.targetSpokenCollocations).toContain("alleviate chronic congestion");

    const receipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: strongTranscript,
      durationSeconds: 76,
      assisted: false,
    });

    expect(receipt.pronunciationAssessed).toBe(false);
    expect(receipt.feedbackMode).toBe("transcript_practice_feedback");
    expect(receipt.paceStatus).toBe("on_target");
    expect(receipt.transferredCollocations).toHaveLength(3);
    expect(receipt.masteryQualified).toBe(true);
    expect(receipt.epistemicStatus).toBe("rubric_verified_evidence");

    // Lexical evidence quote MUST cite the 3rd sentence (where the expression actually lives),
    // with exact UTF-16 offsets even after "İstanbul"!
    const lexicalQuote = receipt.evidenceQuotes.find(
      (q) => q.signal === "lexicalTransfer",
    )!;
    expect(lexicalQuote).toBeDefined();
    expect(lexicalQuote.quote).toContain("alleviate chronic congestion");
    expect(
      strongTranscript.slice(lexicalQuote.startOffset, lexicalQuote.endOffset),
    ).toBe(lexicalQuote.quote);
  });

  it("blocks 15-second short answers even when freshPromptTransfer is true", () => {
    const receipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: strongTranscript,
      durationSeconds: 15,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(receipt.paceStatus).toBe("too_short");
    expect(receipt.masteryQualified).toBe(false);
    expect(receipt.countsTowardMastery).toBe(false);
    expect(receipt.epistemicStatus).toBe("practice_feedback");
    expect(receipt.epistemicReason).not.toContain("已确认");
  });

  it("blocks 0 target hits even when duration is 75s and freshPromptTransfer is true", () => {
    const noTargetTranscript =
      "Personally, I think municipal leaders often prefer highway projects because drivers see immediate asphalt upgrades before the next election. " +
      "However, building big trains takes many years of planning and construction noise across local neighbourhoods. " +
      "Admittedly, families in distant outer districts still need cars to reach schools and clinics when bus routes run infrequently. " +
      "In the long run, cities should coordinate local buses with reliable trains so residents gradually choose shared transit over private driving.";

    const receipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: noTargetTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(receipt.transferredCollocations).toHaveLength(0);
    expect(receipt.masteryQualified).toBe(false);
    expect(receipt.countsTowardMastery).toBe(false);
    expect(receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks empty targetSpokenCollocations list even when freshPromptTransfer is true", () => {
    const emptySeed = { ...baseSeed, targetSpokenCollocations: [] };
    const receipt = evaluateSpeakingRetelling({
      seed: emptySeed,
      transcript: strongTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(receipt.masteryQualified).toBe(false);
    expect(receipt.countsTowardMastery).toBe(false);
    expect(receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks bare pasted target phrases appended to a zero-target transcript at 75s", () => {
    const barePastedTranscript =
      "Personally, I think municipal leaders often prefer highway projects because drivers notice wider roads before the next election. " +
      "However, building large rail systems takes many years of planning and construction noise across local neighbourhoods. " +
      "Admittedly, families in outer districts still need cars when local bus routes run infrequently during evenings. " +
      "In the long run, cities should coordinate buses with reliable trains so residents choose shared transit. " +
      "Alleviate chronic congestion. Per-capita emissions.";

    const receipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: barePastedTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(receipt.transferredCollocations).toHaveLength(0);
    expect(receipt.masteryQualified).toBe(false);
    expect(receipt.countsTowardMastery).toBe(false);
    expect(receipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks bare target phrases tacked onto a complete sentence via colon or comma (': alleviate chronic congestion, per-capita emissions.') at 75s", () => {
    const colonAttachedTranscript =
      "Personally, I think municipal leaders often prefer highway projects because impatient drivers notice wider asphalt roads immediately before the next election. " +
      "However, building large rail systems takes many years of careful planning and disruptive construction noise across local neighbourhoods. " +
      "Admittedly, families in outer suburban districts still need private cars when local bus routes run infrequently during late evenings. " +
      "In the long run, cities should coordinate feeder routes with reliable trains so daily residents choose shared transit: alleviate chronic congestion, per-capita emissions.";

    const colonReceipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: colonAttachedTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(colonReceipt.wordCount).toBeGreaterThanOrEqual(75);
    expect(colonReceipt.transferredCollocations).toHaveLength(0);
    expect(colonReceipt.masteryQualified).toBe(false);
    expect(colonReceipt.countsTowardMastery).toBe(false);
    expect(colonReceipt.epistemicStatus).toBe("practice_feedback");

    const commaAttachedTranscript = colonAttachedTranscript.replace(
      ": alleviate chronic congestion, per-capita emissions.",
      ", alleviate chronic congestion, per-capita emissions.",
    );
    const commaReceipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: commaAttachedTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(commaReceipt.transferredCollocations).toHaveLength(0);
    expect(commaReceipt.masteryQualified).toBe(false);
    expect(commaReceipt.countsTowardMastery).toBe(false);
    expect(commaReceipt.epistemicStatus).toBe("practice_feedback");
  });

  it("blocks comma-tacked ', and the <target>' verbless fragments while crediting valid unpunctuated shared-predicate coordination", () => {
    const pastedAndTheTranscript =
      "Personally, I think municipal leaders often prefer highway projects because impatient drivers notice wider asphalt roads immediately before the next election. " +
      "However, building large rail systems takes many years of careful planning and disruptive construction noise across local neighbourhoods. " +
      "Admittedly, families in outer suburban districts still need private cars when local bus routes run infrequently during late evenings. " +
      "In the long run, cities should coordinate feeder routes with reliable trains so daily residents choose shared transit, and the per-capita emissions, and the long-term fiscal viability.";

    const pastedReceipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: pastedAndTheTranscript,
      durationSeconds: 75,
      assisted: false,
      freshPromptTransfer: true,
    });
    expect(pastedReceipt.wordCount).toBeGreaterThanOrEqual(75);
    expect(pastedReceipt.transferredCollocations).toHaveLength(0);
    expect(pastedReceipt.masteryQualified).toBe(false);
    expect(pastedReceipt.countsTowardMastery).toBe(false);
    expect(pastedReceipt.epistemicStatus).toBe("practice_feedback");

    // Valid unpunctuated direct coordination sharing a governing verb ("should monitor X and Y")
    const coordinatedTranscript =
      "Personally, I think municipal leaders often prefer highway projects because impatient drivers notice wider asphalt roads right before major municipal elections. " +
      "However, building large urban rail networks requires years of careful planning and steady political commitment across densely populated districts. " +
      "Admittedly, families in outer suburban neighbourhoods still rely on cars when local bus routes run infrequently during late evenings. " +
      "The regional transport board should monitor long-term fiscal viability and per-capita emissions before approving expensive highway projects.";

    const coordinatedReceipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: coordinatedTranscript,
      durationSeconds: 75,
      assisted: false,
    });
    expect(coordinatedReceipt.wordCount).toBeGreaterThanOrEqual(75);
    expect(coordinatedReceipt.transferredCollocations).toEqual([
      "long-term fiscal viability",
      "per-capita emissions",
    ]);
    expect(coordinatedReceipt.masteryQualified).toBe(true);
    expect(coordinatedReceipt.countsTowardMastery).toBe(true);
    expect(coordinatedReceipt.epistemicStatus).toBe("rubric_verified_evidence");
  });

  it("emits one grounded citation per credited target hit with exact untrimmed offsets when transcript has leading spaces", () => {
    const untrimmedTranscript =
      "  Personally, I think municipal leaders face short-term political pressure when impatient voters demand wider roads right away. " +
      "Investing steadily in urban rail is the clearest way to alleviate chronic congestion across crowded city centres during peak weekday hours. " +
      "Over time, shifting daily commuters onto electric trains also lowers per-capita emissions in dense neighbourhoods that suffer from poor air quality. " +
      "Admittedly, outer suburbs still rely on frequent feeder buses to reach stations safely during late evenings.";

    const receipt = evaluateSpeakingRetelling({
      seed: baseSeed,
      transcript: untrimmedTranscript,
      durationSeconds: 75,
      assisted: false,
    });

    expect(receipt.transferredCollocations).toEqual([
      "alleviate chronic congestion",
      "per-capita emissions",
    ]);
    expect(receipt.masteryQualified).toBe(true);

    const lexicalQuotes = receipt.evidenceQuotes.filter(
      (q) => q.signal === "lexicalTransfer",
    );
    expect(lexicalQuotes).toHaveLength(2);
    expect(lexicalQuotes[0]!.matchedExpression).toBe("alleviate chronic congestion");
    expect(lexicalQuotes[0]!.quote).toContain("alleviate chronic congestion");
    expect(lexicalQuotes[1]!.matchedExpression).toBe("per-capita emissions");
    expect(lexicalQuotes[1]!.quote).toContain("per-capita emissions");
    expect(lexicalQuotes[0]!.quote).not.toBe(lexicalQuotes[1]!.quote);

    // Every citation (fluency + every lexical target) MUST slice identically from untrimmed transcript!
    for (const quote of receipt.evidenceQuotes) {
      expect(
        untrimmedTranscript.slice(quote.startOffset, quote.endOffset),
      ).toBe(quote.quote);
    }
    // Leading two spaces must not shift the first sentence's startOffset to 0.
    expect(receipt.evidenceQuotes[0]!.startOffset).toBe(2);
  });

  it("blocks NaN or non-finite duration even when freshPromptTransfer is true", () => {
    for (const badDuration of [Number.NaN, Number.POSITIVE_INFINITY, -10, 0]) {
      const receipt = evaluateSpeakingRetelling({
        seed: baseSeed,
        transcript: strongTranscript,
        durationSeconds: badDuration,
        assisted: false,
        freshPromptTransfer: true,
      });
      expect(receipt.paceStatus).toBe("invalid_duration");
      expect(receipt.durationSeconds).toBeNull();
      expect(receipt.masteryQualified).toBe(false);
      expect(receipt.countsTowardMastery).toBe(false);
      expect(receipt.epistemicStatus).toBe("practice_feedback");
      expect(receipt.epistemicReason).not.toContain("已确认");
    }
  });
});

describe("Writing transfer review regressions", () => {
  it("advances past a rejected Unicode match without re-entering a surrogate pair", () => {
    const paragraph = "😀 Great!\uFE0F";
    const exec = RegExp.prototype.exec;
    const rejectedOffsets = new Set<number>();
    const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value) {
      if (value === paragraph.toLowerCase() && this.source === "😀\\s+great!") {
        if (rejectedOffsets.has(this.lastIndex)) throw new Error("Grounding repeated a rejected match");
        rejectedOffsets.add(this.lastIndex);
      }
      return exec.call(this, value);
    });
    try {
      expect(locateGroundedExcerpt(paragraph, "😀 Great!")).toBeNull();
      expect(locateGroundedExcerpt(paragraph, paragraph)?.matchedText).toBe(paragraph);
    } finally {
      spy.mockRestore();
    }
    expect(locateGroundedExcerpt("😀 Great!\uFE0F Then 😀 great!", "😀 Great!")?.matchedText)
      .toBe("😀 great!");
    expect(locateGroundedExcerpt("👩‍🔬 Great!", "🔬 Great!")).toBeNull();
  });

  it.each(["😀 Great!\uFE0F", "Test.\u0301", "a".repeat(129) + "👩‍🔬"])(
    "keeps automatic Writing evidence on grapheme boundaries in %s",
    (paragraph) => {
      const { receipt } = evaluateNonEmptyRevision({
        baselineDraft: DRAFT_1,
        revisedDraft: { ...DRAFT_2, paragraphs: [paragraph] },
        targets: TARGETS,
        receiptId: "r-grapheme",
      });
      const span = receipt.criteria.TR.evidenceSpans[0]!;
      const expected = paragraph.startsWith("a") ? "a".repeat(129) : paragraph;
      expect(span.excerpt).toBe(expected);
      expect(paragraph.slice(span.startOffset, span.endOffset)).toBe(expected);
    },
  );

  it("keeps deterministic Writing evidence grounded around multi-code-unit markup graphemes", () => {
    const comment = `<!-- ${"a".repeat(95)}\r\n😀👩🏾‍💻e\u0301 -->`;
    const revisedDraft = {
      ...DRAFT_2,
      paragraphs: [
        `Urban rail helps commuters  ${comment} every day.`,
      ],
    };

    expect(() => evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft,
      targets: TARGETS,
      receiptId: "r-markup-graphemes",
    })).not.toThrow();
  });

  it.each(["", "<b>\u0301</b>\n"])("cites Writing prose beyond a tag-boundary grapheme (%j)", (prefix) => {
    const excerpt = "Urban rail helps commuters every day.";
    const paragraph = `${prefix}<a b=\u0600>\u0301${excerpt}`;
    const { receipt } = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: { ...DRAFT_2, paragraphs: [paragraph] },
      targets: TARGETS,
      receiptId: "r-markup-boundary",
    });
    for (const assessment of Object.values(receipt.criteria)) {
      expect(assessment.evidenceSpans[0]).toMatchObject({
        excerpt, startOffset: prefix.length + 8, endOffset: paragraph.length,
      });
    }
  });

  it("does not count interior noun lists as substantive rewriting", () => {
    const report = analyzeCrossDraftTransfer({
      draft1: {
        ...DRAFT_1,
        paragraphs: [
          "Rail can reduce per-capita emissions.",
          "Transit should reduce chronic congestion.",
          "Therefore, leaders can build.",
        ],
      },
      draft2: {
        ...DRAFT_2,
        paragraphs: [
          "Rail can, orchard, lantern, glacier, compass, apricot, marble, reduce per-capita emissions.",
          "Transit should, walnut, cactus, harbor, mineral, summit, pebble, reduce chronic congestion.",
          "Therefore, leaders can, a, b, c, d, e, f, build.",
        ],
      },
      targets: TARGETS,
    });
    expect(report.summary.hasSubstantiveRevision).toBe(false);
    expect(report.summary.transferredCount).toBe(0);
  });

  it("checks target context after stripping interior padding even when the rest of the essay is rewritten", () => {
    const baseline = "Therefore, leaders can build safe stations in rural districts before the next regional election.";
    const genuineRevision = DRAFT_2.paragraphs[1]!.replace(
      "Over a twenty-year horizon, predictable transit schedules also anchor commercial productivity and cut municipal road-maintenance costs.",
      "",
    );
    const report = analyzeCrossDraftTransfer({
      draft1: { ...DRAFT_1, paragraphs: [baseline, ...DRAFT_1.paragraphs.slice(1)] },
      draft2: {
        ...DRAFT_2,
        paragraphs: [
          "Therefore, leaders can, a, b, c, d, e, f, build safe shelters near isolated villages during winter emergencies.",
          genuineRevision,
          ...DRAFT_2.paragraphs.slice(2).map((p) => p.replace("therefore ", "")),
        ],
      },
      targets: TARGETS,
    });
    expect(report.summary.hasSubstantiveRevision).toBe(true);
    expect(report.items.find((item) => item.targetId === "t-cohesion")?.revisedMatched)
      .toEqual(["consequently"]);
  });

  it.each([1, 2, 3])("vetoes non-advancing same-prompt version %s", (version) => {
    const result = evaluateNonEmptyRevision({
      baselineDraft: { ...DRAFT_1, version: 3 },
      revisedDraft: { ...DRAFT_2, version },
      targets: TARGETS,
      freshPromptTransfer: true,
      receiptId: "r-invalid-lineage",
    });
    expect(result.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(result.receipt.countsTowardMastery).toBe(false);
  });

  it("binds a direct rubric receipt to a same-prompt advancing baseline", () => {
    const input = {
      receiptId: "r-bound-lineage",
      taskMode: "writing_task2" as const,
      draft: DRAFT_2,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: true,
    };
    const verified = createValidatedRubricReceipt({ ...input, baselineDraft: DRAFT_1 });
    expect(verified.ok && verified.receipt.evidenceSource).toBe("unassisted_cross_draft_transfer");

    for (const baselineDraft of [
      undefined,
      { ...DRAFT_1, promptId: "different-question" },
      { ...DRAFT_1, version: DRAFT_2.version },
    ]) {
      const rejected = createValidatedRubricReceipt({ ...input, baselineDraft });
      expect(rejected.ok && rejected.receipt.epistemicStatus).toBe("practice_feedback");
    }
  });

  it("applies fresh-prompt criteria when prompt IDs differ", () => {
    const candidate = {
      baselineDraft: DRAFT_1,
      revisedDraft: { ...DRAFT_2, promptId: "different-rail-question" },
      targets: TARGETS,
      receiptId: "r-fresh-prompt",
    };
    const unconfirmed = evaluateNonEmptyRevision(candidate);
    expect(unconfirmed.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(unconfirmed.receipt.epistemicStatus).toBe("practice_feedback");

    const fresh = evaluateNonEmptyRevision({
      ...candidate,
      revisedDraft: { ...candidate.revisedDraft, version: 1 },
      freshPromptTransfer: true,
    });
    expect(fresh.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(fresh.receipt.evidenceSource).toBe("unassisted_fresh_prompt_transfer");
    expect(fresh.receipt.countsTowardMastery).toBe(true);
    expect(fresh.transferReport.summary.masteryQualified).toBe(true);

    const noTargets = evaluateNonEmptyRevision({
      ...candidate,
      targets: [],
      freshPromptTransfer: true,
    });
    expect(noTargets.receipt.countsTowardMastery).toBe(false);
  });

  it.each([
    ["consequently", " Consequently ", "CONSEQUENTLY", "consequently", "consequently", "consequently"],
    ["long-term fiscal viability", "fiscal viability", "viability"],
  ])("awards one LR credit to duplicate or overlapping targets (%s)", (...patterns) => {
    const targets = patterns.map((pattern, index): IeltsUpgradeTarget => ({
      id: "lr-target-" + index,
      category: "targetCollocations",
      criterion: "LR",
      label: pattern,
      targetPatterns: [pattern],
      guidance: "Use the expression in a complete argument.",
    }));
    const input = {
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_2,
      receiptId: "r-unique-evidence",
    };
    const single = evaluateNonEmptyRevision({ ...input, targets: targets.slice(0, 1) });
    const duplicated = evaluateNonEmptyRevision({ ...input, targets });
    const repeatedId = evaluateNonEmptyRevision({ ...input, targets: [targets[0]!, targets[0]!] });
    expect(repeatedId.transferReport.summary.transferredCount).toBe(1);
    expect(single.transferReport.summary.transferredCount).toBe(1);
    expect(duplicated.transferReport.summary.transferredCount).toBe(1);
    expect(duplicated.receipt.criteria.LR.band).toBe(single.receipt.criteria.LR.band);
  });
});

describe("Speaking contextual transfer regressions", () => {
  const seed = buildSpeakingPart3Seed({
    promptId: DRAFT_2.promptId,
    topic: "urban transit",
    coreClaim: "Governments should prioritise urban transit.",
    supportingReason: "Reliable trains connect more riders.",
    activeCollocations: ["per-capita emissions", "long-term fiscal viability"],
  }, DRAFT_2.draftId);

  const setup =
    "Personally, I think municipal leaders often prefer highway projects because impatient drivers notice wider asphalt roads right before major municipal elections. " +
    "However, building large urban rail networks requires years of careful planning and steady political commitment across densely populated districts. " +
    "Admittedly, families in outer suburban neighbourhoods still rely on cars when local bus routes run infrequently during late evenings.";

  it("rejects coordinated noun fragments with verb-like modifiers", () => {
    const transcript = setup.slice(0, -1) +
      ", and the per-capita emissions transport funding budget, and the long-term fiscal viability regional support package.";
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.transferredCollocations).toEqual([]);
    expect(receipt.countsTowardMastery).toBe(false);
  });

  it("credits two targets under one concise shared predicate", () => {
    const transcript = setup + " Local officials also face annual budget reviews in spring. The board should monitor long-term fiscal viability and per-capita emissions.";
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.wordCount).toBe(78);
    expect(receipt.transferredCollocations).toEqual(["long-term fiscal viability", "per-capita emissions"]);
    expect(receipt.countsTowardMastery).toBe(true);
  });

  it.each(["😀 Great!\uFE0F", "Test.\u0301"])("keeps the full final grapheme in Speaking quotes for %s", (transcript) => {
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.evidenceQuotes[0]?.quote).toBe(transcript);
    expect(receipt.evidenceQuotes[0]?.endOffset).toBe(transcript.length);
  });

  it("keeps Speaking quote edges on full-transcript grapheme boundaries", () => {
    const quote = "Urban rail helps commuters every day.";
    const transcript = `<a b=\u0600>\u0301${quote}`;
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.evidenceQuotes[0]).toMatchObject({ quote, startOffset: 8, endOffset: transcript.length });
  });
});

describe("Writing lineage and evidence regressions", () => {
  const input = {
    baselineDraft: DRAFT_1,
    revisedDraft: DRAFT_2,
    targets: TARGETS,
    receiptId: "r-round-six",
  };

  it.each([
    "<input disabled>",
    "<textarea readonly></textarea>",
    "<select multiple></select>",
    "<button disabled></button>",
    "<fieldset disabled></fieldset>",
    "<option selected></option>",
    "<optgroup disabled></optgroup>",
    "<details open></details>",
    "<dialog open></dialog>",
    '<div class="essay > words"></div>',
    "<!-- comment words -->",
    "<SCRIPT type='text/plain'>words</SCRIPT>",
    "<style>body { display: none; }</style>",
    '<?xml version="1.0"?><essay:draft status="pending" />',
    "<![CDATA[hidden words]]>",
  ])("keeps a markup-only Writing baseline as practice (%s)", (markup) => {
    const baselineDraft = { ...DRAFT_1, paragraphs: [markup] };
    const revised = evaluateNonEmptyRevision({ ...input, baselineDraft });
    const direct = createValidatedRubricReceipt({
      receiptId: "r-markup-baseline",
      taskMode: "writing_task2",
      draft: DRAFT_2,
      assessments: buildValidDraft2Assessments(),
      baselineDraft,
      crossDraftTransferVerified: true,
    });
    expect(countDraftWords(baselineDraft.paragraphs)).toBe(0);
    expect(revised.receipt).toMatchObject({
      epistemicStatus: "practice_feedback", countsTowardMastery: false, masteryQualified: false,
    });
    expect(revised.transferReport.summary).toMatchObject({ transferredCount: 0, masteryQualified: false });
    expect(direct).toMatchObject({ ok: true, receipt: { masteryQualified: false } });
  });

  it("keeps comparison operators in plain-text Writing prose", () => {
    const paragraphs = ["a < b and c > d"];
    const { transferReport } = evaluateNonEmptyRevision({ ...input, baselineDraft: { ...DRAFT_1, paragraphs } });
    expect(countDraftWords(paragraphs)).toBe(5);
    expect(transferReport.summary.transferredCount).toBe(4);
    expect(countDraftWords(["x < 5 && y > 3"])).toBe(2);
  });

  it("excludes a markup block spanning Writing paragraphs", () => {
    expect(countDraftWords(["<script>", "Only hidden words", "</script>"])).toBe(0);
  });

  it.each([
    "<script src=https://example.com/>Monitor per-capita emissions.</script>",
    "<script src=https://example.com/?v=1&x=2>Monitor per-capita emissions.</script>",
    '<div/title="Local planners should monitor per-capita emissions."></div>',
    "<script/src=https://example.com>Monitor per-capita emissions.</script>",
    "<div data-empty=></div>",
    "<xmp>Monitor per-capita emissions.</xmp>",
    "<noframes>Monitor per-capita emissions.</noframes>",
    "<noembed>Monitor per-capita emissions.</noembed>",
    "<svg><title>Monitor per-capita emissions.</title><text>Hidden words</text></svg>",
    "<math><mtext>Monitor per-capita emissions.</mtext></math>",
    "<!hidden words><?hidden words?>",
    "<form action=https://example.com/>Submit answer</form>",
    "<textarea name=notes/>hidden words</textarea>",
    "<details id=d/>hidden words</details>",
    "<details/>hidden words</details>",
    '<input type="text"disabled>',
    '<div title="Local planners should monitor per-capita emissions across the district."class="x"></div>',
    "<noscript>Fallback words stay hidden.</noscript>",
    "<iframe>Embedded words stay hidden.</iframe>",
    "<template>Template fallback stays hidden.</template>",
    "<object>Object fallback stays hidden.</object>",
    "<canvas>Canvas fallback stays hidden.</canvas>",
    "<audio>Audio fallback stays hidden.</audio>",
    "<video>Video fallback stays hidden.</video>",
  ])("masks non-prose HTML containers and HTML5 attribute edge cases (%s)", (markup) => {
    expect(countDraftWords([markup])).toBe(0);
  });

  it("resumes prose after foreign self-closing tags and an attributed raw-text end tag", () => {
    expect(countDraftWords(['<svg/><math/>Rail helps. <script>Hidden words</script a=">">Buses help.'])).toBe(4);
  });

  it("keeps the contents of a double-escaped script outside draft prose", () => {
    expect(countDraftWords(["<script><!--<script>Hidden</script>Monitor per-capita emissions.--></script>Rail helps."]))
      .toBe(2);
  });

  it("grounds an un-offsetted excerpt in prose instead of a duplicate attribute value", () => {
    const paragraph = '<div title="alleviate chronic congestion">Urban rail helps alleviate chronic congestion across cities.</div>';
    const assessments = buildValidDraft2Assessments().map((assessment) =>
      assessment.criterion === "LR"
        ? {
            ...assessment,
            evidenceSpans: [{ ...assessment.evidenceSpans[0]!, paragraphIndex: 0, excerpt: "alleviate chronic congestion" }],
          }
        : assessment,
    );
    const validated = createValidatedRubricReceipt({
      receiptId: "r-attribute-prose",
      taskMode: "writing_task2",
      draft: { ...DRAFT_2, paragraphs: [paragraph, ...DRAFT_2.paragraphs.slice(1)] },
      assessments,
      crossDraftTransferVerified: true,
    });

    expect(validated.ok).toBe(true);
    if (validated.ok) {
      const span = validated.receipt.criteria.LR.evidenceSpans[0]!;
      expect(span.excerpt).toBe("alleviate chronic congestion");
      expect(paragraph.slice(span.startOffset, span.endOffset)).toBe(span.excerpt);
      expect(span.startOffset).toBeGreaterThan(paragraph.indexOf(">") + 1);
    }
  });

  it("does not use markup-only baselines for fresh-prompt Writing transfer", () => {
    const baselineDraft = { ...DRAFT_1, paragraphs: ["<details open><button disabled>Submit answer</button></details>"] };
    const revisedDraft = { ...DRAFT_2, promptId: "different-rail-question" };
    const revised = evaluateNonEmptyRevision({ ...input, baselineDraft, revisedDraft, freshPromptTransfer: true });
    expect(revised.receipt).toMatchObject({ epistemicStatus: "practice_feedback", masteryQualified: false });
    expect(revised.transferReport.summary).toMatchObject({ transferredCount: 0, masteryQualified: false });
    expect(createValidatedRubricReceipt({
      receiptId: "r-fresh-markup-baseline",
      taskMode: "writing_task2",
      draft: revisedDraft,
      assessments: buildValidDraft2Assessments(),
      baselineDraft,
      crossDraftTransferVerified: false,
      freshPromptTransfer: true,
    })).toMatchObject({ ok: true, receipt: { masteryQualified: false } });
  });

  it.each([[], ["..."], ["   "], ["12345 ???"]].map((paragraphs) => ({ paragraphs })))(
    "keeps a revision with a non-lexical baseline as practice ($paragraphs)",
    ({ paragraphs }) => {
      const baselineDraft = { ...DRAFT_1, paragraphs };
      const direct = createValidatedRubricReceipt({
        receiptId: "r-missing-baseline",
        taskMode: "writing_task2",
        draft: DRAFT_2,
        assessments: buildValidDraft2Assessments(),
        baselineDraft,
        crossDraftTransferVerified: true,
      });
      const { receipt, transferReport } = evaluateNonEmptyRevision({ ...input, baselineDraft });
      expect(receipt).toMatchObject({ epistemicStatus: "practice_feedback", countsTowardMastery: false });
      expect(transferReport.summary).toMatchObject({ meetsCrossDraftVerification: false, transferredCount: 0 });
      expect(direct.ok && direct.receipt.countsTowardMastery).toBe(false);
    },
  );

  it("cites the new target occurrence when the same clause also contains a copied occurrence", () => {
    const copied = "Officials monitor per-capita emissions across remote industrial zones";
    const clause = `${copied} but electrified transit can substantially lower per-capita emissions in crowded urban neighbourhoods`;
    const paragraph = `${clause} where diesel fumes linger near schools and clinics even on days when regional traffic levels remain unusually low.`;
    const { receipt, transferReport } = evaluateNonEmptyRevision({
      ...input,
      baselineDraft: { ...DRAFT_1, paragraphs: [`${copied} to ensure rural factories comply with national reporting requirements during scheduled winter inspections.`, ...DRAFT_1.paragraphs] },
      revisedDraft: { ...DRAFT_2, paragraphs: [paragraph, ...DRAFT_2.paragraphs.map((text) => text.replaceAll("per-capita emissions", "urban air pollution"))] },
      targets: [{ ...TARGETS[0]!, targetPatterns: ["per-capita emissions"] }],
    });
    const span = receipt.criteria.LR.evidenceSpans[0]!;
    expect(transferReport.items[0]?.status).toBe("transferred");
    expect(receipt.countsTowardMastery).toBe(true);
    expect(span.paragraphIndex).toBe(0);
    expect(span.startOffset).toBeGreaterThanOrEqual(paragraph.indexOf("per-capita emissions") + "per-capita emissions".length);
    expect(span.startOffset).toBeLessThanOrEqual(paragraph.lastIndexOf("per-capita emissions"));
    expect(span.endOffset).toBeGreaterThanOrEqual(paragraph.lastIndexOf("per-capita emissions") + "per-capita emissions".length);
    expect(span.excerpt).toBe(paragraph.slice(span.startOffset, span.endOffset));
  });

  it("cites the allocated Task Response occurrence after an unrelated funding sentence", () => {
    const paragraphs = ["The funding table appears in Appendix B.", ...DRAFT_2.paragraphs];
    const { receipt, transferReport } = evaluateNonEmptyRevision({
      ...input,
      revisedDraft: { ...DRAFT_2, paragraphs },
    });
    expect(receipt.epistemicStatus).toBe("rubric_verified_evidence");
    expect(transferReport.items.find(({ criterion }) => criterion === "TR")).toMatchObject({
      status: "transferred",
      matchedParagraphIndices: [3],
    });
    expect(receipt.criteria.TR.evidenceSpans[0]?.excerpt).toMatch(/Admittedly, widening arterial roads|induced traffic demand/u);
    for (const { criterion, status, matchedParagraphIndices, revisedMatched } of transferReport.items) {
      expect(status).toBe("transferred");
      const span = receipt.criteria[criterion].evidenceSpans[0]!;
      expect(matchedParagraphIndices).toEqual([span.paragraphIndex]);
      expect(span.excerpt.toLowerCase()).toContain(revisedMatched[0]);
      expect(paragraphs[span.paragraphIndex]!.slice(span.startOffset, span.endOffset)).toBe(span.excerpt);
    }
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, 3])(
    "rejects a disconnected version 4 revision with parent %s",
    (basedOnVersion) => {
      const result = evaluateRevisedDraftDeterministically({
        ...input,
        revisedDraft: { ...DRAFT_2, version: 4, basedOnVersion },
      });
      expect(result.transferReport.summary.meetsCrossDraftVerification).toBe(false);
      expect(result.receipt?.masteryQualified).toBe(false);
      const direct = createValidatedRubricReceipt({
        ...input,
        taskMode: "writing_task2",
        draft: { ...DRAFT_2, version: 4, basedOnVersion },
        assessments: buildValidDraft2Assessments(),
        crossDraftTransferVerified: true,
      });
      expect(direct.ok && direct.receipt.masteryQualified).toBe(false);
    },
  );

  it("accepts a later draft explicitly bound to the supplied baseline", () => {
    const result = evaluateRevisedDraftDeterministically({
      ...input,
      revisedDraft: { ...DRAFT_2, version: 4, basedOnVersion: 1 },
    });
    expect(result.receipt?.evidenceSource).toBe("unassisted_cross_draft_transfer");
  });

  it.each([[3, false], [1, true]])(
    "requires the explicit fresh-prompt parent %i to match the supplied baseline",
    (basedOnVersion, verified) => {
      const revisedDraft = { ...DRAFT_2, promptId: "another-transport-prompt", version: 4, basedOnVersion };
      const evaluated = evaluateNonEmptyRevision({ ...input, revisedDraft, freshPromptTransfer: true });
      expect(evaluated.transferReport.summary.masteryQualified).toBe(verified);
      expect(evaluated.receipt.countsTowardMastery).toBe(verified);
      const direct = createValidatedRubricReceipt({
        taskMode: "writing_task2",
        receiptId: input.receiptId,
        baselineDraft: DRAFT_1,
        draft: revisedDraft,
        assessments: buildValidDraft2Assessments(),
        crossDraftTransferVerified: false,
        freshPromptTransfer: true,
      });
      expect(direct.ok && direct.receipt.countsTowardMastery).toBe(verified);
    },
  );

  it("counts a repeated Writing target ID once for allocation and mastery", () => {
    const single = evaluateNonEmptyRevision({ ...input, targets: [TARGETS[0]!] });
    const repeated = evaluateNonEmptyRevision({ ...input, targets: Array(3).fill(TARGETS[0]!) });
    expect(single.receipt.masteryQualified).toBe(true);
    expect(repeated.transferReport).toEqual(single.transferReport);
    expect(repeated.receipt.masteryQualified).toBe(true);
  });

  it("includes the diagnosed phrase in a bounded, grapheme-aligned Writing excerpt", () => {
    const phrase = "every coin has two sides";
    const paragraph =
      "  The consultation covered bus routes serving remote communities and asked the council about maintenance costs across the region before someone said that " +
      phrase + " during an otherwise detailed debate on whether to increase fares for late trains and buses. 👩🏾‍💻";
    const evaluated = evaluateNonEmptyRevision({
      ...input,
      revisedDraft: { ...DRAFT_2, paragraphs: [paragraph] },
    });
    const span = evaluated.receipt.criteria.LR.evidenceSpans[0]!;
    expect(span.diagnosis).toContain(phrase);
    expect(span.excerpt).toContain(phrase);
    expect(span.excerpt.length).toBeLessThanOrEqual(130);
    expect(span.startOffset).toBeLessThanOrEqual(paragraph.indexOf(phrase));
    expect(span.endOffset).toBeGreaterThanOrEqual(paragraph.indexOf(phrase) + phrase.length);
    expect(paragraph.slice(span.startOffset, span.endOffset)).toBe(span.excerpt);
    const boundaries = [...new Intl.Segmenter("en").segment(paragraph)].map(({ index }) => index).concat(paragraph.length);
    expect(boundaries).toContain(span.startOffset);
    expect(boundaries).toContain(span.endOffset);
  });

  it.each(["...", "？！ 👋"])("rejects zero-word Writing submissions (%s)", (paragraph) => {
    const revisedDraft = { ...DRAFT_2, paragraphs: [paragraph] };
    expect(evaluateRevisedDraftDeterministically({ ...input, revisedDraft })).toMatchObject({
      ok: false,
      reason: "empty_draft",
      receipt: null,
    });
    const direct = createValidatedRubricReceipt({
      taskMode: "writing_task2",
      receiptId: input.receiptId,
      draft: revisedDraft,
      assessments: buildValidDraft2Assessments().map((assessment) => ({
        ...assessment,
        evidenceSpans: [{ ...assessment.evidenceSpans[0]!, paragraphIndex: 0, excerpt: paragraph }],
      })),
      crossDraftTransferVerified: false,
    });
    expect(direct).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: "EMPTY_DRAFT" })]) });
  });

  it("uses the receipt's mastery decision for assisted transfer", () => {
    const revisedDraft = { ...DRAFT_2, assisted: true };
    const result = evaluateRevisedDraftDeterministically({ ...input, revisedDraft });
    const standalone = analyzeCrossDraftTransfer({ draft1: DRAFT_1, draft2: revisedDraft, targets: TARGETS });
    expect(standalone.summary.masteryQualified).toBe(false);
    expect(result.transferReport.summary.meetsCrossDraftVerification).toBe(true);
    expect(result.transferReport.summary.masteryQualified).toBe(false);
    expect(result.receipt?.masteryQualified).toBe(false);
  });

  it.each([
    "A separate paragraph about buses.",
    "Dr. Patel monitors per-capita emissions near “St. Anne’s”.",
  ])("keeps the original paragraph index and whitespace offsets for %s", (sentence) => {
    const paragraph = "  " + sentence;
    const paragraphs = ["", paragraph, "  "];
    const result = evaluateNonEmptyRevision({
      ...input,
      revisedDraft: { ...DRAFT_2, paragraphs },
    });
    for (const assessment of Object.values(result.receipt.criteria)) {
      expect(assessment.evidenceSpans[0]).toMatchObject({
        paragraphIndex: 1,
        startOffset: 2,
        endOffset: paragraph.length,
        excerpt: sentence,
      });
    }
  });

  it("cites the sentence containing the evidence cue after a quotation", () => {
    const first = "The doctor said \"Expect delays.\"";
    const evidence = "The council monitors emissions each week.";
    const paragraph = first + " " + evidence + " " + evidence;
    const result = evaluateRevisedDraftDeterministically({
      ...input,
      revisedDraft: { ...DRAFT_2, paragraphs: [paragraph] },
    });
    expect(result.receipt?.criteria.LR.evidenceSpans[0]).toMatchObject({
      startOffset: first.length + 1,
      endOffset: first.length + 1 + evidence.length,
      excerpt: evidence,
    });
  });

  it.each([{ paragraphs: [] }, { paragraphs: ["", " \t "] }])(
    "returns an explicit empty result without a receipt for $paragraphs",
    ({ paragraphs }) => {
      const result = evaluateRevisedDraftDeterministically({
        ...input,
        revisedDraft: { ...DRAFT_2, paragraphs },
      });
      expect(result).toMatchObject({ ok: false, reason: "empty_draft", receipt: null });
      expect(result.transferReport.summary.masteryQualified).toBe(false);
    },
  );

  it("allocates distinct evidence to both overlapping target choices in either order", () => {
    const common = { category: "cohesiveDevices", criterion: "CC", guidance: "Connect the claims." } as const;
    const flexible = { ...common, id: "a-flexible", label: "Flexible", targetPatterns: ["therefore", "consequently"] };
    const limited = { ...common, id: "b-limited", label: "Limited", targetPatterns: ["consequently"] };
    const first = evaluateRevisedDraftDeterministically({ ...input, targets: [flexible, limited] });
    const second = evaluateRevisedDraftDeterministically({ ...input, targets: [limited, flexible] });
    expect(first.transferReport.summary).toEqual(second.transferReport.summary);
    expect(first.transferReport.summary.transferredCount).toBe(2);
    expect(first.receipt?.criteria.CC.band).toBe(7);
    expect(second.receipt?.criteria.CC.band).toBe(7);
    expect(first.transferReport.items.find((item) => item.targetId === flexible.id)?.revisedMatched).toEqual(["therefore"]);
    expect(second.transferReport.items.find((item) => item.targetId === flexible.id)?.revisedMatched).toEqual(["therefore"]);
  });
});

describe("Speaking clause and evidence regressions", () => {
  const seed = buildSpeakingPart3Seed({
    promptId: DRAFT_2.promptId,
    topic: "urban transit",
    coreClaim: "Governments should prioritise urban transit.",
    supportingReason: "Reliable trains connect more riders.",
    activeCollocations: ["per-capita emissions"],
  }, DRAFT_2.draftId);
  const setup =
    "Personally, I think municipal leaders often prefer highway projects because impatient drivers notice wider asphalt roads right before major municipal elections. " +
    "Building large urban rail networks requires years of careful planning and steady political commitment across densely populated districts. " +
    "Admittedly, families in outer suburban neighbourhoods still rely on cars when local bus routes run infrequently during late evenings. " +
    "Local officials also face annual budget reviews in spring. " +
    "That debate affects riders as well as taxpayers. ";

  it.each([
    ["The city's reported per-capita emissions for last year.", false],
    ["The cities’ reported per-capita emissions for last year.", false],
    ["Our sharply revised local per-capita emissions plan.", false],
    ["A rapidly revised per-capita emissions plan.", false],
    ["A preliminary revised per-capita emissions plan.", false],
    ["A table of reduced per-capita emissions across districts.", false],
    ["A report on sharply reduced per-capita emissions.", false],
    ["A report on traffic and reduced per-capita emissions.", false],
    ["A breakdown of average reported per-capita emissions by district.", false],
    ["A report on urban reduced per-capita emissions.", false],
    ["A summary of municipal reported per-capita emissions.", false],
    ["A comparison with reported per-capita emissions.", false],
    ["A classification by reduced per-capita emissions.", false],
    ["Our city reported lower per-capita emissions.", true],
    ["The districts with smaller fleets reported lower per-capita emissions.", true],
    ["It's reduced per-capita emissions significantly.", true],
    ["That’s helped cut per-capita emissions.", true],
    ["The city's trains reduced harmful per-capita emissions across the entire city.", true],
    ["The switch to trains reduced harmful per-capita emissions across the entire city.", true],
    ["The council in our city reduced harmful per-capita emissions throughout spring.", true],
    ["The shift from cars to buses reduced harmful per-capita emissions in the region.", true],
    ["The council in our city reported detailed per-capita emissions figures.", true],
    ["The initiative reduced harmful per-capita emissions across the entire city.", true],
    ["The council in our city guaranteed lower per-capita emissions.", true],
    ["The council in our city made per-capita emissions a priority.", true],
    ["The council in our city monitors per-capita emissions each week.", true],
    ["Councils in our region monitor per-capita emissions each week.", true],
    ["The council in our city has reduced per-capita emissions.", true],
  ])("checks subject noun phrases with a verified Writing receipt in %s", (sentence, credited) => {
    const { receipt: verifiedWritingReceipt } = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: DRAFT_2,
      targets: TARGETS,
      receiptId: "r-speaking-subject-source",
    });
    expect(verifiedWritingReceipt.countsTowardMastery).toBe(true);
    const receipt = evaluateSpeakingRetelling({
      seed: { ...seed, requiresVerifiedReceipt: true, verifiedWritingReceipt },
      transcript: setup + sentence,
      durationSeconds: 75,
      assisted: false,
    });
    expect(receipt.wordCount).toBeGreaterThanOrEqual(75);
    expect(receipt.transferredCollocations).toEqual(credited ? ["per-capita emissions"] : []);
    expect(receipt.countsTowardMastery).toBe(credited);
    expect(receipt.epistemicStatus).toBe(credited ? "rubric_verified_evidence" : "practice_feedback");
  });

  it.each([
    "because", "although", "though", "even though", "while", "whereas", "since", "unless",
    "until", "if", "whether", "when", "whenever", "once", "after", "before", "so that",
    "and", "or", "but", "yet", ";", "—",
  ])("scopes Speaking evidence to the target clause across %s", (link) => {
    const evaluate = (sentence: string) => evaluateSpeakingRetelling({
      seed, transcript: setup + sentence, durationSeconds: 75, assisted: false,
    });
    const rejected = evaluate(`Buses are expensive ${link} the city's reported per-capita emissions.`);
    expect(rejected.transferredCollocations).toEqual([]);
    expect(rejected.countsTowardMastery).toBe(false);
    const accepted = evaluate(`Buses are cleaner ${link} the city reduced per-capita emissions.`);
    expect(accepted.transferredCollocations).toEqual(["per-capita emissions"]);
    expect(accepted.countsTowardMastery).toBe(true);
  });

  it.each([
    ["I spoke to the analyst who the city's reported per-capita emissions.", false],
    ["I spoke to the analyst who reported per-capita emissions.", true],
    ["The board hired engineers that reduced per-capita emissions.", true],
    ["The board hired engineers that the city's reported per-capita emissions.", false],
    ["The speaker said, 'Buses are expensive; the city's reported per-capita emissions.'", false],
    ["The speaker said, 'Buses are cleaner—our city reduced per-capita emissions.'", true],
  ])("checks relative and quoted clauses containing the Speaking target in %s", (sentence, credited) => {
    const receipt = evaluateSpeakingRetelling({
      seed, transcript: setup + sentence, durationSeconds: 75, assisted: false,
    });
    expect(receipt.transferredCollocations).toEqual(credited ? ["per-capita emissions"] : []);
    expect(receipt.countsTowardMastery).toBe(credited);
  });

  it.each([
    ["Yesterday in our neighborhood library per-capita emissions support package.", false],
    ["The council offers commuters per-capita emissions data each week.", true],
    ["Dr. Patel monitors per-capita emissions near “St. Anne’s”.", true],
  ])("checks finite predicates and exact quotes in %s", (sentence, credited) => {
    const transcript = "  " + setup + sentence;
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.transferredCollocations).toEqual(credited ? ["per-capita emissions"] : []);
    expect(receipt.masteryQualified).toBe(credited);
    if (credited) {
      expect(receipt.evidenceQuotes.find((quote) => quote.matchedExpression)).toMatchObject({
        quote: sentence,
        startOffset: 2 + setup.length,
        endOffset: transcript.length,
      });
    }
  });

  it.each([
    ["A table of seasonal shifts in per-capita emissions across districts.", false],
    ["A table of seasonal shifts affecting per-capita emissions across districts.", false],
    ["Seasonal shifts significantly affecting per-capita emissions across districts.", false],
    ["A table of reduced per-capita emissions across districts.", false],
    ["A table of sharply reduced per-capita emissions across districts.", false],
    ["A newly revised per-capita emissions plan for the region.", false],
    ["A report on sharp cuts in per-capita emissions across districts.", false],
    ["A newly revised plan for lowering per-capita emissions downtown.", false],
    ["A summary about recent shifts toward lower per-capita emissions.", false],
    ["A table of sharp cuts in old per-capita emissions records.", false],
    ["The regional transport funding strategy for reducing per-capita emissions.", false],
    ["A strategy to consistently cut harmful per-capita emissions across the region.", false],
    ["A strategy to help lower harmful per-capita emissions across the region.", false],
    ["A table of travel times and seasonal shifts in per-capita emissions.", false],
    ["Reliable trains cut harmful per-capita emissions across the entire city.", true],
    ["Reliable trains reduced harmful per-capita emissions across the entire city.", true],
    ["My family reduced harmful per-capita emissions by switching to rail.", true],
    ["The board reported harmful per-capita emissions across the entire city.", true],
    ["The council studied per-capita emissions across the entire city.", true],
    ["Reliable trains are reducing harmful per-capita emissions across the entire city.", true],
    ["Reliable trains could be reducing harmful per-capita emissions across the entire city.", true],
    ["Trains cut harmful per-capita emissions.", true],
    ["Per-capita emissions rise.", true],
    ["The council sets tighter limits on per-capita emissions across the city.", true],
    ["Reliable trains cut those unusually high local per-capita emissions during rush hour.", true],
    ["The transport office offers local residents detailed per-capita emissions data.", true],
    ["The council in nearby towns monitors per-capita emissions every week.", true],
    ["Per-capita emissions shift with the seasonal demand for fuel.", true],
    ["Longer journeys cost households more as per-capita emissions rise.", true],
    ["The rail programme cost every household a small per-capita emissions levy.", true],
    ["The research team put regional per-capita emissions on the agenda.", true],
    ["Public reports let local residents compare per-capita emissions each month.", true],
    ["The city spread annual per-capita emissions across several accounting periods.", true],
    ["The local economy hit a new per-capita emissions record this year.", true],
    ["A longer shutdown hurt those already demanding lower per-capita emissions.", true],
    ["The agency shut outdated per-capita emissions databases throughout the country.", true],
    ["The agency split reported per-capita emissions into distinct categories.", true],
    ["Local planners should invest in rail across the U.S. Per-capita emissions data from the annual report.", false],
    ["Local planners should invest in rail across the U.S. Canada.", false],
    ["Local planners should monitor U.S. per-capita emissions across the district.", true],
  ])("verifies contextual Speaking transfer in %s", (sentence, credited) => {
    const receipt = evaluateSpeakingRetelling({
      seed,
      transcript: setup + sentence,
      durationSeconds: 75,
      assisted: false,
    });
    expect(receipt.transferredCollocations).toEqual(credited ? ["per-capita emissions"] : []);
    expect(receipt.masteryQualified).toBe(credited);
    expect(receipt.countsTowardMastery).toBe(credited);
  });

  it("excludes standalone numbers from the word count and Speaking mastery", () => {
    const verified = createValidatedRubricReceipt({
      receiptId: "r-speaking-numeric-padding",
      taskMode: "writing_task2",
      baselineDraft: DRAFT_1,
      draft: DRAFT_2,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: true,
    });
    if (!verified.ok || !verified.receipt.masteryQualified) throw new Error("Expected a verified Writing fixture");

    const sentence = "Reliable trains cut harmful per-capita emissions across the entire city.";
    const numbers = Array.from({ length: 70 }, (_, index) => index + 1).join(" ");
    const transcript = `${numbers} ${sentence}`;
    const receipt = evaluateSpeakingRetelling({
      seed: { ...seed, requiresVerifiedReceipt: true, verifiedWritingReceipt: verified.receipt },
      transcript,
      durationSeconds: 75,
      assisted: false,
    });
    expect(receipt).toMatchObject({
      wordCount: 10,
      masteryQualified: false,
      countsTowardMastery: false,
      epistemicStatus: "practice_feedback",
      transferredCollocations: ["per-capita emissions"],
    });
    expect(countDraftWords([transcript, "$12.50 / 50% / 18–25 / 2020-2024"])).toBe(10);
  });

  it("counts equivalent Speaking targets once for transfer and mastery", () => {
    const receipt = evaluateSpeakingRetelling({
      seed: {
        ...seed,
        targetSpokenCollocations: ["per-capita emissions", "per-capita emissions", " per-capita  emissions "],
      },
      transcript: setup + "Local planners should monitor per-capita emissions across the district.",
      durationSeconds: 75,
      assisted: false,
    });
    expect(receipt.transferredCollocations).toHaveLength(1);
    expect(receipt.pendingCollocations).toEqual([]);
    expect(receipt.transcriptSignals.lexicalTransfer.note).toContain("1/1");
    expect(receipt.masteryQualified).toBe(true);
  });

  it("provides input guidance without citing punctuation-only Speaking transcripts", () => {
    const receipt = evaluateSpeakingRetelling({ seed, transcript: "...", durationSeconds: 75, assisted: false });
    expect(receipt).toMatchObject({
      wordCount: 0,
      countsTowardMastery: false,
      epistemicStatus: "practice_feedback",
      evidenceQuotes: [],
    });
    expect(receipt.epistemicReason).toContain("英文单词");
  });

  it("does not treat markup-only Speaking transcripts as prose", () => {
    const transcript = '<input disabled><!-- hidden notes --><script>Monitor per-capita emissions.</script>';
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt).toMatchObject({
      wordCount: 0,
      masteryQualified: false,
      transferredCollocations: [],
      evidenceQuotes: [],
    });
  });

  it("does not transfer a Speaking target found only in an attribute", () => {
    const transcript = setup + '<div title="Local planners should monitor per-capita emissions across the district."></div>';
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.transferredCollocations).toEqual([]);
    expect(receipt.masteryQualified).toBe(false);
  });

  it("requires an eligible Writing receipt for the source draft when the seed opts in", () => {
    const transcript = setup + "Local planners should monitor per-capita emissions across the district.";
    const verified = createValidatedRubricReceipt({
      receiptId: "r-speaking-source",
      taskMode: "writing_task2",
      baselineDraft: DRAFT_1,
      draft: DRAFT_2,
      assessments: buildValidDraft2Assessments(),
      crossDraftTransferVerified: true,
    });
    if (!verified.ok) throw new Error("Expected a verified Writing fixture");
    const evaluate = (extra: {
      verifiedTransferIds?: readonly string[];
      verifiedWritingReceipt?: typeof verified.receipt;
    }) => {
      const gatedSeed = { ...seed, requiresVerifiedReceipt: true, ...extra };
      return evaluateSpeakingRetelling({ seed: gatedSeed, transcript, durationSeconds: 75, assisted: false });
    };
    expect(evaluate({ verifiedTransferIds: [] }).epistemicStatus).toBe("practice_feedback");
    expect(evaluate({ verifiedTransferIds: [verified.receipt.receiptId] }).masteryQualified).toBe(false);
    expect(evaluate({
      verifiedWritingReceipt: { ...verified.receipt, draftId: "another-draft" },
    }).masteryQualified).toBe(false);
    expect(evaluate({
      verifiedWritingReceipt: { ...verified.receipt, masteryQualified: false },
    }).masteryQualified).toBe(false);
    expect(evaluate({
      verifiedWritingReceipt: verified.receipt,
      verifiedTransferIds: [],
    }).masteryQualified).toBe(false);
    expect(evaluate({
      verifiedWritingReceipt: verified.receipt,
      verifiedTransferIds: [verified.receipt.receiptId],
    }).epistemicStatus).toBe("rubric_verified_evidence");
  });

  it("gives overlapping spoken targets credit only for distinct occurrences in either order", () => {
    const targets = ["emissions", "per-capita emissions"];
    const sentence = "Local planners should monitor per-capita emissions across the district.";
    const extraSentence = "The regional board tracks emissions from the municipal bus fleet each week.";
    const evaluate = (targetSpokenCollocations: string[], otherSentence: string) =>
      evaluateSpeakingRetelling({
        seed: { ...seed, targetSpokenCollocations },
        transcript: setup + sentence + " " + otherSentence,
        durationSeconds: 75,
        assisted: false,
        createdAt: DRAFT_2.createdAt,
      });

    const forward = evaluate(targets, "");
    const reverse = evaluate([...targets].reverse(), "");
    expect(forward.transferredCollocations).toHaveLength(1);
    expect(reverse.transferredCollocations).toEqual(forward.transferredCollocations);
    expect(forward.masteryQualified).toBe(false);

    const result = evaluate(targets, extraSentence);
    expect(result).toEqual(evaluate([...targets].reverse(), extraSentence));
    expect(result.masteryQualified).toBe(true);
    expect(result.evidenceQuotes.find((quote) => quote.matchedExpression === "emissions")?.quote)
      .toBe(extraSentence);
    expect(result.evidenceQuotes.find((quote) => quote.matchedExpression === "per-capita emissions")?.quote)
      .toBe(sentence);
  });
});

describe("IELTS source boundaries", () => {
  it("keeps abbreviation periods inside sentences with exact original offsets", () => {
    const expected = [
      "Prof. Lane asked Mr. Ross and Mrs. Cole to meet Ms. Singh at No. 7 St. Anne’s Lane.",
      "Dr. J. R. Patel compared U.S. and U.K. rules, e.g. late fees vs. permits, i.e. common restrictions, etc.",
      "The board met again.",
    ];
    const source = "  " + expected.join("\r\n ") + "  ";
    const sentences = segmentIeltsText(source);
    expect(sentences.map(({ text }) => text)).toEqual(expected);
    for (const sentence of sentences) {
      expect(source.slice(sentence.startOffset, sentence.endOffset)).toBe(sentence.text);
    }
  });

  it("splits sentence-final abbreviations and keeps abbreviations within a sentence", () => {
    const expected = [
      "Local planners should invest in rail across the U.S.",
      "Per-capita emissions data from the annual report.",
      "I have transported similar records to the U.K.",
      "Canada.",
      "Records came from the U.S. Senate and U.K. federal agencies.",
      "We compared U.S. emissions, e.g., freight and bus emissions, i.e., common types of road emissions, etc.",
      "“New records arrived this summer.”",
      "We also contacted the E.U.",
      "Eventually, they replied.",
    ];
    const source = " " + expected.join(" ") + " ";
    const sentences = segmentIeltsText(source);
    expect(sentences.map(({ text }) => text)).toEqual(expected);
    for (const sentence of sentences) {
      expect(source.slice(sentence.startOffset, sentence.endOffset)).toBe(sentence.text);
    }
  });

  it("keeps quoted punctuation intact in sentences and separates inner clauses", () => {
    const first = "She said ‘Dr. Ross spoke. Please wait!’";
    const second = "Everyone waited.";
    const sentences = segmentIeltsText(first + " " + second);
    expect(sentences.map(({ text }) => text)).toEqual([first, second]);
    expect(sentences[0]?.clauses.map(({ text }) => text)).toEqual(["She said ‘Dr. Ross spoke", "Please wait!’"]);
  });

  it("uses the supplied occurrence when an excerpt appears more than once", () => {
    const excerpt = "The council monitors emissions each week.";
    const draft = { ...DRAFT_2, paragraphs: [excerpt + " " + excerpt] };
    const span = {
      paragraphIndex: 0,
      excerpt,
      startOffset: excerpt.length + 1,
      endOffset: draft.paragraphs[0]!.length,
    };
    const assessments = buildValidDraft2Assessments().map((assessment) => ({
      ...assessment,
      evidenceSpans: [{ ...assessment.evidenceSpans[0]!, ...span }],
    }));
    const input = { receiptId: "r-exact-occurrence", taskMode: "writing_task2", draft, crossDraftTransferVerified: false } as const;
    const result = createValidatedRubricReceipt({ ...input, assessments });
    expect(result.ok && result.receipt.criteria.TR.evidenceSpans[0]).toMatchObject(span);

    const invalid = createValidatedRubricReceipt({
      ...input,
      assessments: assessments.map((assessment) => ({
        ...assessment,
        evidenceSpans: assessment.evidenceSpans.map((evidence) => ({
          ...evidence, endOffset: evidence.endOffset + 1,
        })),
      })),
    });
    expect(invalid.ok).toBe(false);
  });
});

describe("Writing topic-relevance band grounding", () => {
  const offTopicParagraphs = [
    "Artisanal sourdough baking relies on patient wild fermentation rather than commercial yeast packets. When stoneground rye flour blends with cool spring water at moderate kitchen temperatures, wild lactobacilli slowly produce gentle organic acids that deepen aroma and extend loaf freshness across several crisp mornings. Experienced bakers monitor hydration ratios carefully because subtle shifts in grain protein transform crumb elasticity, blistered crust caramelisation, and savoury tang.",
    "Beyond home kitchens, botanical conservatories preserve rare alpine orchids harvested from misty limestone ridges across northern mountain ranges. Curators regulate greenhouse humidity, filtered sunlight, mineral misting, and pine bark substrates so delicate root tendrils survive harsh seasonal frost cycles without fungal decay. Detailed herbarium notebooks record petal pigmentation, moth pollination timing, nectar chemistry, and seedling germination rates for visiting botanists.",
    "Classical baroque luthiers similarly prize seasoned spruce soundboards rested inside quiet timber lofts for decades before carving arched ribs and decorative rose inlays. Careful amber varnish layering protects fragile wooden soundboxes against dry winter hearths while preserving warm harmonic resonance during intimate chamber recitals. Dedicated apprentices spend years sharpening gouges, matching flamed maple grain patterns, carving ebony pegs, and tuning gut strings by ear.",
    "Ultimately, traditional craft disciplines ranging from hearth bread fermentation to alpine botanical stewardship and historical string instrument making reward attentive observation, tactile patience, steady curiosity, and deep respect for raw natural materials. Passing these enduring artisanal skills down through quiet studio workshops keeps cultural craftsmanship thriving for curious enthusiasts who treasure handmade precision, acoustic warmth, and seasonal rhythm over rapid factory output.",
  ];

  it("caps Task Response below Band 5.0 and overall band at <= 4.5 for a varied 250-word off-topic essay with zero prompt overlap", () => {
    expect(countDraftWords(offTopicParagraphs)).toBeGreaterThanOrEqual(250);
    const offTopicDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-off-topic-250",
      paragraphs: offTopicParagraphs,
    };

    const withoutStatement = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: offTopicDraft,
      targets: TARGETS,
      receiptId: "r-off-topic-no-stmt",
    });
    expect(withoutStatement.transferReport.summary.hasLowEntropyStuffing).toBe(false);
    expect(withoutStatement.transferReport.summary.transferredCount).toBe(0);
    expect(withoutStatement.receipt.criteria.TR.band).toBeLessThan(5);
    expect(withoutStatement.receipt.criteria.TR.band).toBeLessThanOrEqual(4);
    expect(withoutStatement.receipt.overallBand).toBeLessThanOrEqual(4.5);
    expect(withoutStatement.receipt.masteryQualified).toBe(false);
    expect(withoutStatement.receipt.countsTowardMastery).toBe(false);
    expect(withoutStatement.receipt.epistemicStatus).toBe("practice_feedback");

    const withStatement = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: offTopicDraft,
      targets: TARGETS,
      promptStatement:
        "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
      receiptId: "r-off-topic-with-stmt",
    });
    expect(withStatement.receipt.criteria.TR.band).toBeLessThan(5);
    expect(withStatement.receipt.overallBand).toBeLessThanOrEqual(4.5);
    expect(withStatement.receipt.criteria.TR.summary).toContain("偏离题干");
  });

  it("withholds transfer credit and enforces off-topic TR/CC caps when an off-topic essay includes generic connectors like consequently, therefore, and admittedly", () => {
    const offTopicWithConnectors: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-off-topic-connectors",
      paragraphs: [
        `Admittedly, ${offTopicParagraphs[0]}`,
        `Consequently, ${offTopicParagraphs[1]}`,
        `${offTopicParagraphs[2]} Therefore, luthiers inspect spruce rings patiently before gluing soundboards.`,
        offTopicParagraphs[3]!,
      ],
    };
    expect(countDraftWords(offTopicWithConnectors.paragraphs)).toBeGreaterThanOrEqual(250);

    for (const promptStatement of [
      undefined,
      "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
    ]) {
      const evaluated = evaluateNonEmptyRevision({
        baselineDraft: DRAFT_1,
        revisedDraft: offTopicWithConnectors,
        targets: TARGETS,
        promptStatement,
        receiptId: promptStatement ? "r-off-topic-conn-stmt" : "r-off-topic-conn-nostmt",
      });
      expect(evaluated.transferReport.summary.transferredCount).toBe(0);
      expect(evaluated.transferReport.items.every((item) => item.status !== "transferred")).toBe(true);
      expect(evaluated.receipt.criteria.TR.band).toBeLessThanOrEqual(4);
      expect(evaluated.receipt.criteria.CC.band).toBeLessThanOrEqual(4.5);
      expect(evaluated.receipt.overallBand).toBeLessThanOrEqual(4.5);
      expect(evaluated.receipt.masteryQualified).toBe(false);
      expect(evaluated.receipt.countsTowardMastery).toBe(false);
      expect(evaluated.receipt.epistemicStatus).toBe("practice_feedback");
    }
  });

  it("caps off-topic essays against an explicit promptStatement even when targets are empty", () => {
    const museumPrompt =
      "Should national museums charge entrance fees to international visitors instead of offering free admission to everyone?";
    const customPromptDraft: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-museum-off-topic",
      promptId: "museum-admission-fees-v1",
      paragraphs: offTopicParagraphs,
    };
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: customPromptDraft,
      targets: [],
      promptStatement: museumPrompt,
      receiptId: "r-off-topic-custom-prompt",
    });
    expect(evaluated.receipt.criteria.TR.band).toBe(4);
    expect(evaluated.receipt.overallBand).toBeLessThanOrEqual(4.5);

    // Step-2 regression: adding a single incidental venue sentence ("museum" + "entrance")
    // without addressing fees/charges/free admission must STILL receive 0 lengthBonus and stay capped!
    const incidentalVenueDraft: IeltsEssayDraft = {
      ...customPromptDraft,
      draftId: "draft-2-museum-incidental-venue",
      paragraphs: [
        ...offTopicParagraphs.slice(0, 3),
        `${offTopicParagraphs[3]} I visited a museum where the entrance hall displayed antique instruments.`,
      ],
    };
    const venueResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: incidentalVenueDraft,
      targets: [],
      promptStatement: museumPrompt,
      receiptId: "r-off-topic-museum-incidental",
    });
    expect(venueResult.receipt.criteria.TR.band).toBeLessThanOrEqual(4);
    expect(venueResult.receipt.overallBand).toBeLessThanOrEqual(4.5);

    // Even multi-paragraph venue name-dropping with 0 policy/contrast facet coverage stays capped.
    const multiParagraphVenueOnly: IeltsEssayDraft = {
      ...customPromptDraft,
      draftId: "draft-2-museum-venue-only",
      paragraphs: [
        `${offTopicParagraphs[0]} International visitors toured a museum gallery near the entrance hall.`,
        `${offTopicParagraphs[1]} Curious international visitors admired antique orchids inside the museum entrance hall.`,
        ...offTopicParagraphs.slice(2),
      ],
    };
    const venueOnlyResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: multiParagraphVenueOnly,
      targets: [],
      promptStatement: museumPrompt,
      receiptId: "r-off-topic-museum-venue-only",
    });
    expect(venueOnlyResult.receipt.criteria.TR.band).toBeLessThanOrEqual(4.5);
    expect(venueOnlyResult.receipt.overallBand).toBeLessThanOrEqual(4.5);

    // Genuine on-topic essay debating museum entrance fees vs free admission passes cleanly.
    const genuineMuseumEssay: IeltsEssayDraft = {
      ...customPromptDraft,
      draftId: "draft-2-museum-on-topic",
      paragraphs: [
        "Cultural ministries frequently debate whether national museums should charge entrance fees to international visitors instead of preserving free admission for everyone. While open access encourages broad cultural curiosity, modest ticket charges for overseas tourists represent a pragmatic balance between heritage preservation and civic equity.",
        "Maintaining temperature-controlled galleries, conservation laboratories, and scholarly archives demands substantial annual budgets. Asking international visitors who already pay for flights and hotels to cover a modest entrance fee generates reliable revenue without raising domestic taxes on local households that already fund national museums through payroll contributions.",
        "Admittedly, advocates of universal free admission warn that ticket barriers can deter young backpackers, visiting students, and low-income travellers from exploring world heritage collections. Museums can readily resolve this concern by waiving admission charges for students, children, and scheduled free evening hours while keeping standard entrance fees for adult foreign tourists.",
        "Overall, selective entrance fees for international visitors protect the long-term maintenance of national museums while safeguarding free admission for residents and concession groups. Policymakers should therefore adopt tiered ticketing rather than relying solely on stretched cultural subsidies.",
      ],
    };
    const onTopicMuseum = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: genuineMuseumEssay,
      targets: [],
      promptStatement: museumPrompt,
      receiptId: "r-on-topic-museum",
    });
    expect(onTopicMuseum.receipt.criteria.TR.band).toBeGreaterThanOrEqual(6);
    expect(onTopicMuseum.receipt.overallBand).toBeGreaterThanOrEqual(6);
  });

  it("does not apply an off-topic cap to a genuine 250-word on-topic essay even with zero exact target matches", () => {
    const onTopicWithoutTargets: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-on-topic-plain",
      paragraphs: [
        "Growing cities face mounting pressure over whether municipal budgets belong in metropolitan rail lines or wider highways for private cars. Although drivers enjoy door-to-door flexibility when new lanes open, devoting major funding to trains produces stronger mobility and cleaner air for dense neighbourhoods over decades.",
        "Electric commuter trains carry far larger passenger volumes across a narrow corridor than multi-lane arterial roads can handle during weekday rush hours. When office workers and students shift from solo driving to reliable trains, street gridlock eases noticeably and tailpipe pollution declines around schools, clinics, and busy shopping hubs.",
        "Critics note that suburban households living miles from major stations still depend on personal vehicles for evening errands and weekend travel. Even so, widening expressways soon fills fresh lanes with additional drivers, whereas pairing core rail corridors with frequent neighbourhood shuttle routes links outer districts directly to city centres.",
        "For these reasons, city planners should anchor transport spending in modern rail transit and local bus links rather than endless asphalt expansion. Balanced rail networks keep commuting dependable, curb urban smog, and protect taxpayers from recurring highway upkeep expenses.",
      ],
    };
    expect(countDraftWords(onTopicWithoutTargets.paragraphs)).toBeGreaterThanOrEqual(180);
    const evaluated = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: onTopicWithoutTargets,
      targets: TARGETS,
      promptStatement:
        "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
      receiptId: "r-on-topic-plain",
    });
    expect(evaluated.transferReport.summary.transferredCount).toBe(0);
    expect(evaluated.receipt.criteria.TR.band).toBeGreaterThanOrEqual(6);
    expect(evaluated.receipt.overallBand).toBeGreaterThanOrEqual(6);
  });

  it("caps short (< 160 words) off-topic drafts with 1 incidental prompt keyword while allowing short genuinely on-topic drafts", () => {
    const museumPrompt =
      "Should national museums charge entrance fees to international visitors instead of offering free admission to everyone?";
    const shortMuseumOffTopic: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-short-museum-1kw",
      promptId: "museum-admission-fees-v1",
      paragraphs: [
        "Artisanal sourdough fermentation rewards steady kitchen discipline when rye flour mixes slowly with cool spring water across crisp mornings. Therefore, observant bakers measure hydration ratios carefully before shaping rustic loaves for local cafes.",
        "Consequently, botanical conservatories nurture fragile alpine orchids harvested from misty limestone ridges by controlling pine bark drainage and gentle humidity. Yesterday I passed a quiet museum courtyard while carrying wildflower sketches home for my notebook.",
      ],
    };
    const shortMuseumWords = countDraftWords(shortMuseumOffTopic.paragraphs);
    expect(shortMuseumWords).toBeGreaterThanOrEqual(60);
    expect(shortMuseumWords).toBeLessThan(160);

    const shortMuseumResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: shortMuseumOffTopic,
      targets: TARGETS,
      promptStatement: museumPrompt,
      receiptId: "r-short-museum-1kw",
    });
    expect(shortMuseumResult.transferReport.summary.transferredCount).toBe(0);
    expect(shortMuseumResult.receipt.criteria.TR.band).toBeLessThanOrEqual(4);
    expect(shortMuseumResult.receipt.criteria.CC.band).toBeLessThanOrEqual(4.5);
    expect(shortMuseumResult.receipt.overallBand).toBeLessThanOrEqual(4.5);
    expect(shortMuseumResult.receipt.masteryQualified).toBe(false);
    expect(shortMuseumResult.receipt.countsTowardMastery).toBe(false);
    expect(shortMuseumResult.receipt.epistemicStatus).toBe("practice_feedback");

    const shortRailOffTopic: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-short-rail-1kw",
      paragraphs: [
        "Classical baroque luthiers age seasoned spruce timber inside dry wooden lofts before carving delicate arched ribs and maple bridges. Therefore, careful varnish layering protects warm acoustic resonance across intimate winter chamber recitals.",
        "Consequently, artisanal sourdough bakers monitor hydration ratios and wild yeast activity across quiet urban bakeries while preserving handmade culinary traditions for curious hobbyists.",
      ],
    };
    const shortRailWords = countDraftWords(shortRailOffTopic.paragraphs);
    expect(shortRailWords).toBeGreaterThanOrEqual(50);
    expect(shortRailWords).toBeLessThan(160);

    for (const promptStatement of [
      undefined,
      "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
    ]) {
      const shortRailResult = evaluateNonEmptyRevision({
        baselineDraft: DRAFT_1,
        revisedDraft: shortRailOffTopic,
        targets: TARGETS,
        promptStatement,
        receiptId: promptStatement ? "r-short-rail-1kw-stmt" : "r-short-rail-1kw-nostmt",
      });
      expect(shortRailResult.transferReport.summary.transferredCount).toBe(0);
      expect(shortRailResult.receipt.criteria.TR.band).toBeLessThanOrEqual(4);
      expect(shortRailResult.receipt.criteria.CC.band).toBeLessThanOrEqual(4.5);
      expect(shortRailResult.receipt.overallBand).toBeLessThanOrEqual(4.5);
      expect(shortRailResult.receipt.masteryQualified).toBe(false);
      expect(shortRailResult.receipt.countsTowardMastery).toBe(false);
      expect(shortRailResult.receipt.epistemicStatus).toBe("practice_feedback");
    }

    // A short (< 160 words) genuinely on-topic draft addressing both contrast facets is NOT capped as off-topic.
    const shortOnTopicMuseum: IeltsEssayDraft = {
      ...DRAFT_2,
      draftId: "draft-2-short-museum-on-topic",
      promptId: "museum-admission-fees-v1",
      paragraphs: [
        "National museums should charge modest entrance fees to international visitors instead of offering universal free admission to everyone. Conservation laboratories and historic galleries require steady funding, and overseas tourists already budget for flights and accommodation.",
        "Admittedly, free admission lowers barriers for visiting students and low-income families, so museums should keep concession waivers and free weekly evenings while charging standard tickets to adult international visitors.",
      ],
    };
    const shortOnTopicWords = countDraftWords(shortOnTopicMuseum.paragraphs);
    expect(shortOnTopicWords).toBeGreaterThanOrEqual(60);
    expect(shortOnTopicWords).toBeLessThan(160);

    const shortOnTopicResult = evaluateNonEmptyRevision({
      baselineDraft: DRAFT_1,
      revisedDraft: shortOnTopicMuseum,
      targets: [],
      promptStatement: museumPrompt,
      receiptId: "r-short-museum-on-topic",
    });
    expect(shortOnTopicResult.receipt.criteria.TR.band).toBeGreaterThanOrEqual(5.5);
    expect(shortOnTopicResult.receipt.overallBand).toBeGreaterThanOrEqual(5.5);
  });
});
