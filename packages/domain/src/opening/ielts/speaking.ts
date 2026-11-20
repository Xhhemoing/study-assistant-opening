import {
  countEnglishWords,
  detectMemorizedTemplates,
  hasMemorizedTemplateStuffing,
  locateGroundedExcerpt,
} from "./rubric";
import { detectLowEntropyStuffing } from "./transfer";
import {
  IELTS_CARTRIDGE_ID,
  type IeltsSpeakingEvidenceQuote,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPaceStatus,
  type IeltsSpeakingPart3Seed,
  type IeltsSpeakingRetellingInput,
  type IeltsSpeakingSignalKey,
  type IeltsSpeakingTranscriptSignal,
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

const MIN_VERIFIED_SPEAKING_WORDS = 75;

const SPEAKING_SCOPE_NOTE =
  "当前仅基于口语转写文本与作答时长进行迁移检核，不含真实语音发音（Pronunciation）与声学流利度评分，不构成官方口语 Band。";

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPhraseRegex(phrase: string): RegExp {
  const parts = phrase.trim().split(/\s+/).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
}

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

function classifySpeakingPace(
  durationSeconds: number,
  window: { readonly min: number; readonly max: number },
): IeltsSpeakingPaceStatus {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return "invalid_duration";
  }
  if (durationSeconds < window.min) return "too_short";
  if (durationSeconds > window.max) return "over_time";
  return "on_target";
}

type GroundedSentence = {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

/**
 * Splits a transcript into sentences while preserving exact UTF-16 offsets
 * into the original transcript string (Unicode-safe, zero index drift).
 */
function extractGroundedSentences(transcript: string): GroundedSentence[] {
  const results: GroundedSentence[] = [];
  const regex = /[^.!?\n]+(?:[.!?]+|$)/gu;
  for (const match of transcript.matchAll(regex)) {
    const raw = match[0];
    const startRaw = match.index ?? 0;
    const leadingSpaces = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const startOffset = startRaw + leadingSpaces;
    const endOffset = startOffset + trimmed.length;
    results.push({
      text: transcript.slice(startOffset, endOffset),
      startOffset,
      endOffset,
    });
  }
  return results;
}

/**
 * Evaluates a learner's Speaking Part 3 oral retelling transcript with strict
 * duration/target/transfer verification (no fresh-prompt bypass), Unicode-safe
 * exact sentence citations, and honest transcript-only speaking signals (no fake
 * official Band or Writing Task Response claim).
 */
export function evaluateSpeakingRetelling(
  input: IeltsSpeakingRetellingInput,
): IeltsSpeakingFeedbackReceipt {
  const trimmedTranscript = input.transcript.trim();
  const wordCount = countEnglishWords(trimmedTranscript);
  const paceStatus = classifySpeakingPace(
    input.durationSeconds,
    input.seed.timeWindowSeconds,
  );
  const safeDurationSeconds =
    Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? input.durationSeconds
      : null;

  const paragraphs = trimmedTranscript ? [trimmedTranscript] : [];
  const memorizedTemplateHits = detectMemorizedTemplates(paragraphs);
  const hasStuffing = hasMemorizedTemplateStuffing(memorizedTemplateHits);
  const hasLowEntropy = detectLowEntropyStuffing(paragraphs);
  const sentences = extractGroundedSentences(trimmedTranscript);

  // Match target collocations strictly via Unicode-safe regex on actual sentences.
  const transferredCollocations: string[] = [];
  const pendingCollocations: string[] = [];
  const matchedSentenceByCollocation = new Map<string, GroundedSentence>();

  for (const collocation of input.seed.targetSpokenCollocations) {
    const regex = buildPhraseRegex(collocation);
    const containingSentence = sentences.find((sentence) => regex.test(sentence.text));
    if (containingSentence) {
      transferredCollocations.push(collocation);
      matchedSentenceByCollocation.set(collocation, containingSentence);
    } else {
      pendingCollocations.push(collocation);
    }
  }

  const hasSpokenSignpost =
    /\b(personally|to be honest|that said|on the other hand|in the long run|the main reason|admittedly|for instance|for example|on top of that)\b/iu.test(
      trimmedTranscript,
    );
  const hasComplexClause =
    /\b(while|although|even though|whereas|which|because|if|unless)\b/iu.test(
      trimmedTranscript,
    );
  const hasStiffWrittenConnector =
    /\b(furthermore|moreover|henceforth|in conclusion)\b/iu.test(trimmedTranscript);

  // Build exact, Unicode-safe, sentence-aligned evidence quotes.
  const evidenceQuotes: IeltsSpeakingEvidenceQuote[] = [];

  if (sentences.length > 0) {
    const firstSentence = sentences[0]!;
    evidenceQuotes.push({
      id: `${input.seed.seedId}-sp-fluency`,
      signal: "fluencyCohesion",
      quote: firstSentence.text,
      startOffset: firstSentence.startOffset,
      endOffset: firstSentence.endOffset,
      diagnosis:
        hasStiffWrittenConnector
          ? "转写中带有明显书面连接词（如 Furthermore / In conclusion），口语中改用 That said / On top of that 会更自然。"
          : hasSpokenSignpost && paceStatus === "on_target"
            ? "开头直接切入政策权衡并具备清晰口语过渡线索，时长控制在目标窗口内。"
            : paceStatus === "too_short"
              ? "回应偏短（不足 60 秒），建议补一个具体城市或通勤者视角把观点说透。"
              : paceStatus === "invalid_duration"
                ? "未提供有效作答时长，无法确认节奏控制，请在 60–90 秒内重新计时复述。"
                : "可进一步用口语路标词（Personally / That said / For instance）串联观点的正反两面。",
      upgradeRewrite:
        "Personally, I think the core tension is that drivers feel highway widening right away, whereas urban rail takes years to pay off.",
    });

    // For lexicalTransfer quote: strictly cite the ACTUAL sentence containing a matched collocation!
    if (transferredCollocations.length > 0) {
      const firstMatchedExpression = transferredCollocations[0]!;
      const matchedSentence = matchedSentenceByCollocation.get(firstMatchedExpression)!;
      const inThisSentence = transferredCollocations.filter((expr) =>
        buildPhraseRegex(expr).test(matchedSentence.text),
      );
      const loc = locateGroundedExcerpt(trimmedTranscript, matchedSentence.text);
      evidenceQuotes.push({
        id: `${input.seed.seedId}-sp-lexical`,
        signal: "lexicalTransfer",
        quote: matchedSentence.text,
        matchedExpression: inThisSentence.join(" / "),
        startOffset: loc?.startOffset ?? matchedSentence.startOffset,
        endOffset: loc?.endOffset ?? matchedSentence.endOffset,
        diagnosis: `该句已自然迁移写作目标表达（${inThisSentence.join(" / ")}），使口语论述更具体。`,
        upgradeRewrite:
          pendingCollocations.length > 0
            ? `下一轮可继续把尚未用到的表达带入口语：${pendingCollocations.slice(0, 2).join(", ")}。`
            : "继续保持这种把精准搭配融入自然口语句式的表达习惯，避免生硬背诵书面语。",
      });
    } else if (input.seed.targetSpokenCollocations.length > 0) {
      const longestSentence = [...sentences].sort(
        (a, b) => b.text.length - a.text.length,
      )[0]!;
      evidenceQuotes.push({
        id: `${input.seed.seedId}-sp-lexical`,
        signal: "lexicalTransfer",
        quote: longestSentence.text,
        startOffset: longestSentence.startOffset,
        endOffset: longestSentence.endOffset,
        diagnosis: "本次转写尚未命中任何目标活性搭配，建议结合提示词把写作二稿中的核心搭配自然说出来。",
        upgradeRewrite: `可尝试自然带出：${input.seed.targetSpokenCollocations.slice(0, 2).join(", ")}。`,
      });
    }
  }

  // Airtight mastery / verification gate — NEVER bypassed by freshPromptTransfer!
  const targetCount = input.seed.targetSpokenCollocations.length;
  const requiredTransferred = targetCount > 0 ? Math.min(2, targetCount) : 1;
  const hasEnoughTargets = targetCount > 0;
  const hasEnoughTransfer =
    hasEnoughTargets && transferredCollocations.length >= requiredTransferred;
  const hasValidPace = paceStatus === "on_target";
  const hasEnoughWords = wordCount >= MIN_VERIFIED_SPEAKING_WORDS;

  const masteryQualified =
    !input.assisted &&
    hasValidPace &&
    hasEnoughTargets &&
    hasEnoughTransfer &&
    hasEnoughWords &&
    !hasStuffing &&
    !hasLowEntropy &&
    !hasStiffWrittenConnector;

  const epistemicStatus = masteryQualified
    ? "rubric_verified_evidence"
    : "practice_feedback";

  let epistemicReason: string;
  if (masteryQualified) {
    epistemicReason = input.freshPromptTransfer
      ? `独立在 ${input.seed.timeWindowSeconds.min}–${input.seed.timeWindowSeconds.max} 秒内完成新题口语迁移并命中 ${transferredCollocations.length} 组目标搭配，已确认为口语转写迁移证据（不含语音发音评分）。`
      : `独立在 ${input.seed.timeWindowSeconds.min}–${input.seed.timeWindowSeconds.max} 秒内完成 Part 3 追问复述并命中 ${transferredCollocations.length} 组目标搭配，已确认为口语转写迁移证据（不含语音发音评分）。`;
  } else if (input.assisted) {
    epistemicReason = "本次口语复述参照了写作稿件或提示，仅作转写练习反馈，不计入正式掌握度。";
  } else if (paceStatus === "invalid_duration") {
    epistemicReason = "作答时长无效或缺失，无法确认是否落在 60–90 秒有效区间，本次仅作转写练习反馈。";
  } else if (!hasValidPace) {
    epistemicReason =
      paceStatus === "too_short"
        ? `当前作答时长（${safeDurationSeconds} 秒）低于 60–90 秒有效窗口，本次仅作转写练习反馈。`
        : `当前作答时长（${safeDurationSeconds} 秒）超出 60–90 秒有效窗口，建议精炼观点后重新复述。`;
  } else if (!hasEnoughTargets) {
    epistemicReason = "当前题卡未配置目标口语迁移表达，无法完成迁移检核，仅作转写练习反馈。";
  } else if (hasStuffing || hasLowEntropy) {
    epistemicReason = "检测到模板套话或低信息量重复填充，本次仅作转写练习反馈，不计入正式掌握度。";
  } else if (hasStiffWrittenConnector) {
    epistemicReason = "检测到偏生硬的书面连接词（如 Furthermore / In conclusion），改用自然口语衔接后可重新复核。";
  } else if (!hasEnoughWords) {
    epistemicReason = `当前转写有效词数为 ${wordCount} 词，低于 60–90 秒口语展开门槛（${MIN_VERIFIED_SPEAKING_WORDS} 词），暂作转写练习反馈。`;
  } else {
    epistemicReason = `当前命中 ${transferredCollocations.length}/${targetCount} 组目标搭配（至少需自然迁移 ${requiredTransferred} 组），本次仅作转写练习反馈。`;
  }

  const transcriptSignals: Record<IeltsSpeakingSignalKey, IeltsSpeakingTranscriptSignal> = {
    fluencyCohesion: {
      key: "fluencyCohesion",
      label: "流利与衔接线索",
      rating:
        hasStiffWrittenConnector || hasLowEntropy
          ? "needs_work"
          : hasSpokenSignpost && hasEnoughWords
            ? "strong"
            : "developing",
      note: hasStiffWrittenConnector
        ? "出现书面语连接词，建议改用 That said / On top of that 等自然口语路标词。"
        : hasSpokenSignpost
          ? "转写具备清晰的口语路标词与正反推进线索（不含声学停顿检测）。"
          : "可补充 Personally / That said / For instance 等口语衔接词增强节奏。",
    },
    lexicalTransfer: {
      key: "lexicalTransfer",
      label: "词汇迁移",
      rating: !hasEnoughTargets || transferredCollocations.length === 0
        ? "needs_work"
        : hasEnoughTransfer && !hasStuffing
          ? "strong"
          : "developing",
      note: !hasEnoughTargets
        ? "未设定目标迁移搭配，当前仅记录基础词汇使用。"
        : transferredCollocations.length > 0
          ? `已迁移 ${transferredCollocations.length}/${targetCount} 组写作二稿活性搭配。`
          : `尚未命中目标搭配（0/${targetCount}），建议在下轮口语中自然带出 2 组以上。`,
    },
    syntacticVariety: {
      key: "syntacticVariety",
      label: "句式多样性",
      rating:
        hasComplexClause && hasEnoughWords && !hasLowEntropy
          ? "strong"
          : hasComplexClause
            ? "developing"
            : "needs_work",
      note: hasComplexClause
        ? "自然运用了让步或因果从句（While / Whereas / Because），口语句式有层次。"
        : "句式偏短平，建议用 While / Even though 引出对比或让步视角。",
    },
    durationCompliance: {
      key: "durationCompliance",
      label: "时长达标度",
      rating:
        paceStatus === "on_target" && hasEnoughWords
          ? "strong"
          : paceStatus === "on_target"
            ? "developing"
            : "needs_work",
      note:
        paceStatus === "invalid_duration"
          ? "时长无效，需记录有效的 60–90 秒计时结果。"
          : paceStatus === "on_target"
            ? `作答 ${safeDurationSeconds} 秒，落在 60–90 秒目标区间内。`
            : paceStatus === "too_short"
              ? `作答 ${safeDurationSeconds} 秒，低于 60 秒下限，观点展开偏简略。`
              : `作答 ${safeDurationSeconds} 秒，超过 90 秒上限，建议收紧收尾。`,
    },
  };

  return {
    receiptId: `speaking-receipt-${input.seed.seedId}`,
    cartridgeId: IELTS_CARTRIDGE_ID,
    seedId: input.seed.seedId,
    taskMode: "speaking_part3",
    feedbackMode: "transcript_practice_feedback",
    pronunciationAssessed: false,
    assessmentScopeNote: SPEAKING_SCOPE_NOTE,
    epistemicStatus,
    countsTowardMastery: masteryQualified,
    masteryQualified,
    epistemicReason,
    wordCount,
    durationSeconds: safeDurationSeconds,
    paceStatus,
    transferredCollocations,
    pendingCollocations,
    evidenceQuotes,
    memorizedTemplateHits,
    transcriptSignals,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
