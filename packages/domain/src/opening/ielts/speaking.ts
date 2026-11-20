import {
  clampToIeltsBand,
  computeOverallIeltsBand,
  countEnglishWords,
  detectMemorizedTemplates,
  hasMemorizedTemplateStuffing,
  locateGroundedExcerpt,
  resolveIeltsEpistemicStatus,
} from "./rubric";
import {
  IELTS_CARTRIDGE_ID,
  type IeltsBandScore,
  type IeltsCriterion,
  type IeltsSpanEvidence,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPaceStatus,
  type IeltsSpeakingPart3Seed,
  type IeltsSpeakingRetellingInput,
  type IeltsWritingCoreArgument,
} from "./types";

const STIFF_WRITTEN_ONLY_PHRASES = [
  "furthermore",
  "moreover",
  "nevertheless",
  "henceforth",
  "in conclusion",
  "it is undeniable that",
] as const;

const DEFAULT_AVOID_IN_SPEECH = [
  "Furthermore / Moreover（口语中显得像背作文，改用 On top of that / Another factor is）",
  "In conclusion（口语收束更自然用 So overall / Taken together）",
  "Every coin has two sides（套话谚语，直接说出具体权衡点）",
] as const;

function cleanSpokenCollocations(rawCollocations: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawCollocations) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (STIFF_WRITTEN_ONLY_PHRASES.some((stiff) => lower === stiff)) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      cleaned.push(trimmed);
    }
  }
  return cleaned;
}

/**
 * Converts a learner's refined Writing Task 2 core claim + reason into an authentic
 * 60-90s IELTS Speaking Part 3 abstract discussion follow-up seed.
 */
export function buildSpeakingPart3Seed(
  argument: IeltsWritingCoreArgument,
  sourceDraftId: string,
): IeltsSpeakingPart3Seed {
  const topicClean = argument.topic.trim() || "urban public policy";
  const targetSpokenCollocations = cleanSpokenCollocations(argument.activeCollocations);

  const followUpQuestion = `Thinking more broadly about ${topicClean}, why do you think governments still struggle to balance short-term public convenience with long-term investment?`;
  const followUpQuestionZh = `延伸追问：围绕「${topicClean}」，为什么政府在短期公众便利与长期公共投入之间依然难以平衡？请在 60–90 秒内用口语自然展开你的核心主张与反方权衡。`;

  const argumentBridgeCues = [
    `直接亮明核心判断：${argument.coreClaim}`,
    `给出因果展开：${argument.supportingReason}`,
    argument.counterPerspective
      ? `自然带出让步视角：${argument.counterPerspective}`
      : "补一句让步视角（Admittedly... / That said...），让口语回应更有层次。",
  ];

  return {
    seedId: `speaking-p3-${argument.promptId}-${sourceDraftId}`,
    cartridgeId: IELTS_CARTRIDGE_ID,
    sourcePromptId: argument.promptId,
    sourceDraftId,
    topic: topicClean,
    followUpQuestion,
    followUpQuestionZh,
    timeWindowSeconds: { min: 60, max: 90 },
    targetSpokenCollocations,
    argumentBridgeCues,
    avoidWrittenClunkyPhrases: [...DEFAULT_AVOID_IN_SPEECH],
  };
}

function classifySpeakingPace(durationSeconds: number): IeltsSpeakingPaceStatus {
  if (durationSeconds < 60) return "too_short";
  if (durationSeconds > 90) return "over_time";
  return "on_target";
}

function extractSentences(transcript: string): string[] {
  const raw = transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : [transcript.trim()].filter(Boolean);
}

/**
 * Evaluates a learner's Speaking Part 3 oral retelling transcript with span-grounded
 * quotes, active collocation transfer tracking, pace check, and honest epistemology.
 */
export function evaluateSpeakingRetelling(
  input: IeltsSpeakingRetellingInput,
): IeltsSpeakingFeedbackReceipt {
  const trimmedTranscript = input.transcript.trim();
  const paragraphs = [trimmedTranscript || "(No spoken response recorded)"];
  const wordCount = countEnglishWords(trimmedTranscript);
  const paceStatus = classifySpeakingPace(input.durationSeconds);
  const memorizedTemplateHits = detectMemorizedTemplates(paragraphs);
  const hasStuffing = hasMemorizedTemplateStuffing(memorizedTemplateHits);

  const lowerTranscript = trimmedTranscript.toLowerCase();
  const transferredCollocations: string[] = [];
  const pendingCollocations: string[] = [];

  for (const collocation of input.seed.targetSpokenCollocations) {
    if (lowerTranscript.includes(collocation.toLowerCase())) {
      transferredCollocations.push(collocation);
    } else {
      pendingCollocations.push(collocation);
    }
  }

  const hasSpokenSignpost = /\b(personally|to be honest|that said|on the other hand|in the long run|the main reason|admittedly|for instance|for example)\b/i.test(
    trimmedTranscript,
  );
  const hasComplexClause = /\b(while|although|even though|whereas|which|because|if)\b/i.test(
    trimmedTranscript,
  );
  const hasStiffWrittenConnector = /\b(furthermore|moreover|henceforth|in conclusion)\b/i.test(
    trimmedTranscript,
  );

  const transferRatio =
    input.seed.targetSpokenCollocations.length > 0
      ? transferredCollocations.length / input.seed.targetSpokenCollocations.length
      : 0;

  const paceBonus = paceStatus === "on_target" ? 0.5 : -0.5;
  const templatePenalty = hasStuffing ? 1.0 : memorizedTemplateHits.length > 0 ? 0.5 : 0;

  const trBand = clampToIeltsBand(
    6.0 + (wordCount >= 85 ? 0.5 : -0.5) + (paceStatus === "on_target" ? 0.5 : 0) - templatePenalty * 0.5,
  );
  const ccBand = clampToIeltsBand(
    6.0 + (hasSpokenSignpost ? 0.5 : 0) + (hasStiffWrittenConnector ? -0.5 : 0.5) + paceBonus * 0.5,
  );
  const lrBand = clampToIeltsBand(
    6.0 + (transferRatio >= 0.5 ? 1.0 : transferredCollocations.length > 0 ? 0.5 : 0) - templatePenalty,
  );
  const graBand = clampToIeltsBand(
    6.0 + (hasComplexClause ? 0.5 : 0) + (wordCount >= 90 ? 0.5 : 0),
  );

  const scores: Record<IeltsCriterion, IeltsBandScore> = {
    TR: trBand,
    CC: ccBand,
    LR: lrBand,
    GRA: graBand,
  };
  const estimatedBand = computeOverallIeltsBand(scores);

  const sentences = extractSentences(trimmedTranscript);
  const firstSentence = sentences[0] ?? trimmedTranscript;
  const secondSentence = sentences[1] ?? firstSentence;

  const evidenceSpans: IeltsSpanEvidence[] = [];
  if (firstSentence) {
    const loc = locateGroundedExcerpt(trimmedTranscript, firstSentence);
    evidenceSpans.push({
      id: `${input.seed.seedId}-sp-tr`,
      paragraphIndex: 0,
      excerpt: firstSentence,
      criterion: "TR",
      diagnosis:
        wordCount >= 85 && paceStatus === "on_target"
          ? "回应直接切入抽象政策权衡，展开长度符合 Part 3 追问预期。"
          : paceStatus === "too_short"
            ? "口语展开偏短（不足 60 秒），建议补一个具体城市或通勤者的例子。"
            : "回应较长，注意在 60–90 秒内收束核心判断，避免原地重复。",
      upgradeRewrite:
        "I think the main tension is that voters feel road improvements immediately, whereas high-capacity rail takes years to pay off.",
      startOffset: loc?.startOffset,
      endOffset: loc?.endOffset,
    });
  }

  if (secondSentence) {
    const loc = locateGroundedExcerpt(trimmedTranscript, secondSentence);
    evidenceSpans.push({
      id: `${input.seed.seedId}-sp-lr`,
      paragraphIndex: 0,
      excerpt: secondSentence,
      criterion: "LR",
      diagnosis:
        transferredCollocations.length > 0
          ? `已成功把写作中的核心搭配迁移到口语表达（${transferredCollocations.join(" / ")}）。`
          : "写作二稿中的目标搭配尚未出现在口语复述中，建议下轮至少自然带出 2 组搭配。",
      upgradeRewrite:
        transferredCollocations.length > 0
          ? "Keep using concrete phrases like long-term fiscal viability and per-capita emissions with natural spoken signposts."
          : `Try weaving in: ${input.seed.targetSpokenCollocations.slice(0, 2).join(", ")}.`,
      startOffset: loc?.startOffset,
      endOffset: loc?.endOffset,
    });
  }

  const meetsOralTransfer =
    paceStatus === "on_target" &&
    transferredCollocations.length >= Math.min(2, input.seed.targetSpokenCollocations.length) &&
    !hasStiffWrittenConnector;

  const epistemic = resolveIeltsEpistemicStatus({
    draftVersion: 2,
    assisted: input.assisted,
    crossDraftTransferVerified: meetsOralTransfer,
    freshPromptTransfer: input.freshPromptTransfer,
    memorizedTemplateHits,
    wordCount,
    minVerifiedWords: 75,
  });

  const epistemicReason =
    epistemic.epistemicStatus === "rubric_verified_evidence"
      ? "独立在 60–90 秒内完成 Part 3 追问复述，并自然迁移写作精修搭配，已确认为量规复核证据。"
      : input.assisted
        ? "本次口语复述开启了提示或稿件参照，仅作练习诊断反馈，不计入正式掌握度。"
        : hasStuffing
          ? "口语回答包含明显模板套话，需改为自然口语逻辑后重新复述。"
          : paceStatus !== "on_target"
            ? "时长未落在 60–90 秒目标区间内，本次保留为练习诊断反馈。"
            : hasStiffWrittenConnector
              ? "检测到偏生硬的书面连接词（如 Furthermore / In conclusion），改用自然口语衔接后可升级为量规复核证据。"
              : "核心目标搭配迁移数量尚未达标，建议再完成一轮独立口语复述。";

  return {
    receiptId: `speaking-receipt-${input.seed.seedId}`,
    cartridgeId: IELTS_CARTRIDGE_ID,
    seedId: input.seed.seedId,
    taskMode: "speaking_part3",
    estimatedBand,
    epistemicStatus: epistemic.epistemicStatus,
    countsTowardMastery: epistemic.countsTowardMastery,
    epistemicReason,
    wordCount,
    durationSeconds: input.durationSeconds,
    paceStatus,
    transferredCollocations,
    pendingCollocations,
    evidenceSpans,
    memorizedTemplateHits,
    criteriaNotes: {
      TR: {
        band: trBand,
        note:
          wordCount >= 85
            ? "能从个人体验上升到城市与公共预算层面展开分析。"
            : "论点偏简短，可补充反方权衡或现实案例延展。",
      },
      CC: {
        band: ccBand,
        note: hasStiffWrittenConnector
          ? "带有书面连接词痕迹，口语中改用 That said / On top of that 更自然。"
          : hasSpokenSignpost
            ? "口语衔接自然，观点推进有清晰的路标词。"
            : "可加入 That said / For instance 等口语过渡词增强节奏。",
      },
      LR: {
        band: lrBand,
        note:
          transferredCollocations.length > 0
            ? `已迁移 ${transferredCollocations.length}/${input.seed.targetSpokenCollocations.length} 组目标搭配。`
            : "尚未带出目标活性搭配，建议结合提示词再练一轮。",
      },
      GRA: {
        band: graBand,
        note: hasComplexClause
          ? "自然运用了让步或因果复合句，口语句法有层次。"
          : "句式偏单一，尝试用 While / Even though 引出对比视角。",
      },
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
