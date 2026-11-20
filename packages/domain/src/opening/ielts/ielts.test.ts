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
    const evaluated = evaluateRevisedDraftDeterministically({
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
    const singleDraftResult = evaluateRevisedDraftDeterministically({
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
    const evaluated = evaluateRevisedDraftDeterministically({
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

    const evaluated = evaluateRevisedDraftDeterministically({
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

    const colonResult = evaluateRevisedDraftDeterministically({
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

    const commaResult = evaluateRevisedDraftDeterministically({
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

    const evaluated = evaluateRevisedDraftDeterministically({
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
    const evaluated = evaluateRevisedDraftDeterministically({
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

    const evaluated = evaluateRevisedDraftDeterministically({
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
    const evaluated = evaluateRevisedDraftDeterministically({
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
      "per-capita emissions",
      "long-term fiscal viability",
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
      const { receipt } = evaluateRevisedDraftDeterministically({
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
    const result = evaluateRevisedDraftDeterministically({
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
    const unconfirmed = evaluateRevisedDraftDeterministically(candidate);
    expect(unconfirmed.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(unconfirmed.receipt.epistemicStatus).toBe("practice_feedback");

    const fresh = evaluateRevisedDraftDeterministically({
      ...candidate,
      revisedDraft: { ...candidate.revisedDraft, version: 1 },
      freshPromptTransfer: true,
    });
    expect(fresh.transferReport.summary.meetsCrossDraftVerification).toBe(false);
    expect(fresh.receipt.evidenceSource).toBe("unassisted_fresh_prompt_transfer");
    expect(fresh.receipt.countsTowardMastery).toBe(true);

    const noTargets = evaluateRevisedDraftDeterministically({
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
    const single = evaluateRevisedDraftDeterministically({ ...input, targets: targets.slice(0, 1) });
    const duplicated = evaluateRevisedDraftDeterministically({ ...input, targets });
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
    expect(receipt.transferredCollocations).toEqual(seed.targetSpokenCollocations);
    expect(receipt.countsTowardMastery).toBe(true);
  });

  it.each(["😀 Great!\uFE0F", "Test.\u0301"])("keeps the full final grapheme in Speaking quotes for %s", (transcript) => {
    const receipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 75, assisted: false });
    expect(receipt.evidenceQuotes[0]?.quote).toBe(transcript);
    expect(receipt.evidenceQuotes[0]?.endOffset).toBe(transcript.length);
  });
});
