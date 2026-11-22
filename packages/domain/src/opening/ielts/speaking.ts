import { graphemeBoundaries, trimToProseGraphemes } from "./graphemes";
import { allocateIeltsSpans, compareText, type MatchRange } from "./span-allocation";
import { countProseWords, maskIeltsMarkup } from "./prose";
import { segmentIeltsText, type GroundedSentence } from "./text-segments";
import {
  detectMemorizedTemplates,
  hasMemorizedTemplateStuffing,
} from "./rubric";
import { detectLowEntropyStuffing, isVerifiedWritingReceipt } from "./transfer";
import {
  IELTS_CARTRIDGE_ID,
  isDenseIeltsArray,
  isNonBlankIeltsString,
  readIeltsPromptId,
  type IeltsSpeakingEvidenceQuote,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPaceStatus,
  type IeltsSpeakingPart3Seed,
  type IeltsSpeakingRetellingInput,
  type IeltsSpeakingSignalKey,
  type IeltsSpeakingTranscriptSignal,
  type IeltsWritingCoreArgument,
} from "./types";

export const IELTS_URBAN_RAIL_SPEAKING_PROMPT = Object.freeze({
  promptId: "ielts-task2-urban-rail-funding",
  promptStatement: "Some people believe that governments should invest public funds primarily in urban rail networks rather than expanding road systems for private vehicles. To what extent do you agree or disagree?",
  targetSpokenCollocations: Object.freeze([
    "alleviate chronic congestion",
    "per-capita emissions",
    "long-term fiscal viability",
    "induced traffic demand",
    "feeder buses",
  ]),
});

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

const SPEAKING_STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "are", "was", "were", "will", "would", "could", "should", "into", "onto",
  "about", "more", "most", "some", "many", "such", "very", "also", "than",
  "then", "they", "them", "their", "there", "these", "those", "only", "just",
  "can", "not", "but", "all", "one", "two", "its", "our", "you", "your",
  "too", "now", "how", "why", "who", "what", "when", "where",
]);

const SPEAKING_CLAUSE_VERB_CUE =
  /^(?:be|think|believe|feel|see|say|says|said|mean|means|meant|make|makes|made|take|takes|took|help|helps|helped|lower|lowers|ease|eases|need|needs|want|wants|rely|relies|build|builds|spend|spends|invest|invests|fund|funds|protect|protects|back|backs|pair|pairs|trigger|triggers|grow|grows|matter|matters|require|requires|struggle|struggles|notice|notices|pour|pours|choose|chooses|avoid|avoids|reduce|reduces|alleviate|alleviates|improve|improves|deliver|delivers|encourage|encourages|undermine|undermines|resolve|resolves|support|supports|prefer|prefers|coordinate|coordinates|monitor|monitors|approve|approves|track|tracks|evaluate|evaluates|balance|balances|weigh|weighs|assess|assesses|shift|shifts|curb|curbs|maintain|maintains|expand|expands|address|addresses|justify|justifies)$/u;

const MIN_VERIFIED_SPEAKING_WORDS = 75;

const SPEAKING_SCOPE_NOTE =
  "当前仅基于口语转写文本与作答时长进行迁移检核，不含真实语音发音（Pronunciation）与声学流利度评分，不构成官方口语 Band。";

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPhraseRegex(phrase: string): RegExp {
  const parts = phrase.trim().split(/\s+/).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");
}

const SPEAKING_MODAL = /^(?:can|could|may|might|must|shall|should|will|would)$/u;
const SPEAKING_FINITE_AUXILIARY = /^(?:is|are|was|were|am|do|does|did|have|has|had)$/u;
const SPEAKING_DETERMINER = /^(?:the|a|an|this|that|these|those|whose|my|our|your|his|her|its|their)$/u;
const SPEAKING_POSSESSIVE_END = /(?:['’]s|s['’])$/u;
const SPEAKING_PRENOMINAL_ADJECTIVE =
  /^(?:new|old|recent|latest|last|first|final|initial|preliminary|local|regional|annual|seasonal|comprehensive|average|urban|rural|national|total|overall|estimated|high|low|higher|lower)$/u;
const SPEAKING_ADJECTIVAL_ENDING = /(?:al|ic|ive|ous|ary|able|ible|ful|less|wide)$/u;
const SPEAKING_UNINFLECTED_VERB = /^(?:cut|set|put|cost|let|spread|hit|hurt|shut|split)s?$/u;
const SPEAKING_AMBIGUOUS_VERB = /^(?:help|helps|need|needs|fund|funds|back|backs|pair|pairs|support|supports|monitor|monitors|track|tracks|balance|balances|shift|shifts|address|addresses|offer|offers|trigger|triggers|notice|notices|curb|curbs)$/u;
const SPEAKING_SUBJECT_PRONOUN = /^(?:i|you|he|she|it|we|they)$/u;
const SPEAKING_CONTRACTED_SUBJECT = /^(?:(?:he|she|it|that|this|there)['’]s|i['’]m|(?:you|we|they)['’](?:re|ve)|(?:i|you|he|she|it|we|they|that)['’](?:ll|d)|i['’]ve)$/u;
const SPEAKING_OBJECT_PRONOUN = /^(?:me|you|him|her|it|us|them)$/u;
const SPEAKING_DITRANSITIVE = /^(?:give|gives|gave|offer|offers|offered|show|shows|showed|send|sends|sent|tell|tells|told)$/u;
const SPEAKING_PREPOSITION = /^(?:of|to|for|with|on|at|from|by|in|near|under|over|about|across|through|throughout|between|among|into|onto|within|outside|against|towards?|without|after|before|during)$/u;
const SPEAKING_COORDINATOR = /^(?:and|or|but|nor|yet)$/u;
const SPEAKING_SUBORDINATOR = /^(?:although|though|while|whereas|if|unless|until|whether|when|whenever|once|after|before|where|whose|whom|who|which|because|since)$/u;
const SPEAKING_RELATIVE_SUBJECT = /^(?:who|which|that)$/u;
const SPEAKING_COPULA = /^(?:is|are|was|were|am)$/u;
const SPEAKING_PREDICATIVE_ADJECTIVE = /^(?:expensive|cheap|clean|cleaner|costly|difficult|easy|important|popular|reliable|necessary|affordable|better|worse|available|effective|efficient)$/u;
const SPEAKING_ADVERB = /^(?:not|never|often|sometimes|always|already|still|also|only|just|really|rather|then|today|yesterday|tomorrow|newly|recently|previously|sharply|slightly|significantly)$/u;
const SPEAKING_LY_NOUN = /^(?:ally|assembly|family|fly|italy|july|reply|supply)$/u;
const SPEAKING_INTRANSITIVE_END = /^(?:rise|rises|rose|fall|falls|fell|grow|grows|grew|vary|varies|varied|matter|matters|mattered)$/u;
const SPEAKING_PRESENT_PARTICIPLE = /^[a-z]{2,}ing$/u;
const SPEAKING_REGULAR_PAST = /^[a-z]{2,}ed$/u;

function isSpokenAdverbCue(word: string): boolean {
  return SPEAKING_ADVERB.test(word) || (word.endsWith("ly") && !SPEAKING_LY_NOUN.test(word));
}

function isSpokenVerb(word: string): boolean {
  return SPEAKING_CLAUSE_VERB_CUE.test(word) || SPEAKING_FINITE_AUXILIARY.test(word) ||
    SPEAKING_UNINFLECTED_VERB.test(word) || SPEAKING_DITRANSITIVE.test(word);
}

type SpokenTargetSpan = MatchRange & { readonly target: string };
type SpokenWord = { readonly text: string; readonly index: number; readonly end: number };

function hasTargetInVerbObject(
  words: readonly SpokenWord[],
  targetStarts: ReadonlySet<number>,
  allowObjectComplement: boolean,
): boolean {
  let hasObjectHead = false;
  let inObjectComplement = false;
  for (const { text, index } of words) {
    if (targetStarts.has(index)) return true;
    if (SPEAKING_COORDINATOR.test(text) ||
      SPEAKING_MODAL.test(text) || SPEAKING_FINITE_AUXILIARY.test(text)) return false;
    if (SPEAKING_PREPOSITION.test(text)) {
      if (!allowObjectComplement || !hasObjectHead || inObjectComplement) return false;
      inObjectComplement = true;
    } else if (!SPEAKING_DETERMINER.test(text) && !SPEAKING_ADVERB.test(text)) {
      hasObjectHead = true;
    }
  }
  return false;
}

function findSpokenPredicate(
  words: readonly SpokenWord[],
  targetSpans: readonly SpokenTargetSpan[],
  relativeSubject?: string,
): number | undefined {
  const targetStarts = new Set(targetSpans.map(({ start }) => start));
  let subjectHead = relativeSubject;
  let inSubjectComplement = false;
  let complementHead: string | undefined;
  let complementHasDeterminer = false;
  let canStartInfinitive = false;
  let infinitiveComplement = false;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const { text } = word;
    if (SPEAKING_PREPOSITION.test(text)) {
      inSubjectComplement = true;
      complementHead = undefined;
      complementHasDeterminer = false;
      canStartInfinitive = text === "to";
      infinitiveComplement = false;
      continue;
    }

    const next = words[i + 1]?.text;
    if (isSpokenAdverbCue(text)) continue;
    const insideTarget = targetSpans.some(({ start, end }) => word.index >= start && word.index < end);
    if (!subjectHead && !inSubjectComplement && !insideTarget && next && SPEAKING_CONTRACTED_SUBJECT.test(text)) {
      return i;
    }
    if (SPEAKING_DETERMINER.test(text) || SPEAKING_POSSESSIVE_END.test(text) || SPEAKING_COORDINATOR.test(text)) {
      // Open a new nominal slot for a modifier or the next coordinated noun.
      if (inSubjectComplement) {
        complementHead = undefined;
        complementHasDeterminer = !SPEAKING_COORDINATOR.test(text);
      } else subjectHead = undefined;
      canStartInfinitive = false;
      continue;
    }
    if (canStartInfinitive) {
      infinitiveComplement = isSpokenVerb(text);
      canStartInfinitive = false;
    }
    const nominalHead = inSubjectComplement ? complementHead : subjectHead;
    const regularPast = SPEAKING_REGULAR_PAST.test(text);
    // A target such as "alleviate chronic congestion" can start at the finite verb.
    const startsWithPredicate = targetStarts.has(word.index) && !inSubjectComplement &&
      isSpokenVerb(text) && (SPEAKING_SUBJECT_PRONOUN.test(subjectHead ?? "") ||
        (!SPEAKING_AMBIGUOUS_VERB.test(text) && !SPEAKING_UNINFLECTED_VERB.test(text)));
    if (subjectHead && nominalHead && (!insideTarget || startsWithPredicate)) {
      if (!next) {
        if (!infinitiveComplement && SPEAKING_INTRANSITIVE_END.test(text)) return i;
      } else if (SPEAKING_MODAL.test(text)) {
        const complement = words.slice(i + 1).find(({ text: part }) => !isSpokenAdverbCue(part));
        if (complement && isSpokenVerb(complement.text)) return i;
      } else if (SPEAKING_FINITE_AUXILIARY.test(text)) {
        return i;
      } else if (!infinitiveComplement && text !== "be") {
        const knownVerb = isSpokenVerb(text);
        if (knownVerb || regularPast) {
          const ambiguousVerb = SPEAKING_AMBIGUOUS_VERB.test(text) || SPEAKING_UNINFLECTED_VERB.test(text);
          const object = words.slice(i + 1, i + 6);
          const objectStart = object.find(({ text: part }) => !isSpokenAdverbCue(part));
          // A bare participle can modify the preceding noun, as in "shifts affecting emissions".
          const possiblyNounModifier = (ambiguousVerb || (inSubjectComplement && !regularPast)) &&
            SPEAKING_PRESENT_PARTICIPLE.test(objectStart?.text ?? "");
          const takesTarget = !possiblyNounModifier &&
            hasTargetInVerbObject(object, targetStarts, regularPast || !inSubjectComplement);
          if (takesTarget || SPEAKING_DETERMINER.test(next) || SPEAKING_OBJECT_PRONOUN.test(next)) return i;

          if (knownVerb && !inSubjectComplement && (
            SPEAKING_SUBJECT_PRONOUN.test(subjectHead) || !ambiguousVerb ||
            (SPEAKING_PREPOSITION.test(next) && /[^s]s$/u.test(subjectHead))
          )) return i;
        }
      }
    }

    // Without a noun head, a participle or adjective can introduce the noun phrase.
    const prenominalModifier = SPEAKING_PRENOMINAL_ADJECTIVE.test(text) || (regularPast && !text.endsWith("eed")) ||
      (inSubjectComplement && !complementHasDeterminer && SPEAKING_ADJECTIVAL_ENDING.test(text) &&
        SPEAKING_REGULAR_PAST.test(next ?? ""));
    if (!nominalHead && prenominalModifier) continue;
    const canHeadNounPhrase = SPEAKING_SUBJECT_PRONOUN.test(text) ||
      (text.length >= 2 && !SPEAKING_STOP_WORDS.has(text) &&
        !SPEAKING_MODAL.test(text) && !SPEAKING_FINITE_AUXILIARY.test(text));
    if (canHeadNounPhrase) {
      if (inSubjectComplement) complementHead = text;
      else subjectHead = text;
    }
  }
}

function hasAdjacentSpokenTargets(
  segment: string,
  spans: readonly SpokenTargetSpan[],
): boolean {
  // Adjacent target phrases without intervening words are a mechanical list.
  let previousEnd = -1;
  for (const { start, end } of spans) {
    if (previousEnd >= 0 && start >= previousEnd && !segment.slice(previousEnd, start).trim()) {
      return true;
    }
    previousEnd = Math.max(previousEnd, end);
  }
  return false;
}

function isSubordinateBoundary(words: readonly SpokenWord[], index: number): boolean {
  const text = words[index]!.text;
  const next = words[index + 1]?.text ?? "";
  const previous = words[index - 1]?.text ?? "";
  if (SPEAKING_SUBORDINATOR.test(text)) return text !== "because" || next !== "of";
  if (text === "as") return !/^(?:well|long|soon|much|many|such|known|regarded|viewed|seen)$/u.test(next) &&
    !/^(?:well|such|same|known|regarded|viewed|seen)$/u.test(previous);
  if (text === "so") return next === "that" || SPEAKING_DETERMINER.test(next) || SPEAKING_SUBJECT_PRONOUN.test(next);
  if (text !== "that" || index === 0 || previous === "so" || SPEAKING_COORDINATOR.test(previous)) return false;

  // "That" can also be a determiner in a verb's object ("measure that level").
  return SPEAKING_DETERMINER.test(next) || SPEAKING_SUBJECT_PRONOUN.test(next) || SPEAKING_POSSESSIVE_END.test(next) ||
    (!SPEAKING_PREPOSITION.test(previous) && (isSpokenVerb(next) || isSpokenAdverbCue(next) ||
      SPEAKING_MODAL.test(next) || SPEAKING_REGULAR_PAST.test(next)));
}

function startsCoordinatedClause(
  left: readonly SpokenWord[],
  right: readonly SpokenWord[],
  targets: readonly SpokenTargetSpan[],
  relativeSubject?: string,
): boolean {
  const predicateIndex = findSpokenPredicate(left, targets, relativeSubject);
  if (predicateIndex === undefined) return false;
  if (findSpokenPredicate(right, targets) !== undefined) return true;

  const rightStart = right.find(({ text }) => !isSpokenAdverbCue(text))?.text ?? "";
  if (SPEAKING_SUBJECT_PRONOUN.test(rightStart) && !SPEAKING_OBJECT_PRONOUN.test(rightStart)) return true;

  // A predicative adjective cannot share its copula with a trailing noun phrase.
  const complement = left.slice(predicateIndex + 1).filter(({ text }) => !isSpokenAdverbCue(text));
  return SPEAKING_COPULA.test(left[predicateIndex]!.text) && complement.length === 1 &&
    SPEAKING_PREDICATIVE_ADJECTIVE.test(complement[0]!.text) &&
    (SPEAKING_DETERMINER.test(rightStart) || SPEAKING_POSSESSIVE_END.test(rightStart) ||
      targets.some(({ start }) => start === right[0]?.index));
}

function contextualSpokenTargets(segment: string, spans: readonly SpokenTargetSpan[]): SpokenTargetSpan[] {
  const words = Array.from(
    segment.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*(?:(?<=s)['’](?![\p{L}\p{N}]))?/giu),
    (word) => ({ text: word[0].toLowerCase(), index: word.index, end: word.index + word[0].length }),
  );
  const boundaries = words.map((_, index) => isSubordinateBoundary(words, index));
  const contextual: SpokenTargetSpan[] = [];
  let start = 0;
  let startOffset = 0;
  let relativeSubject: string | undefined;

  function creditScope(end: number) {
    const matches = spans.filter((span) => span.start >= startOffset &&
      span.end <= (words[end]?.index ?? segment.length));
    if (matches.length > 0 && !hasAdjacentSpokenTargets(segment, matches) &&
      findSpokenPredicate(words.slice(start, end), matches, relativeSubject) !== undefined) {
      contextual.push(...matches);
    }
  }

  for (const [index, { text, index: wordOffset }] of words.entries()) {
    // Quoted text can retain semicolons and dashes inside a single spoken part.
    const previousEnd = words[index - 1]?.end ?? 0;
    if (/[;—–]|-{2,}|\s-\s/u.test(segment.slice(previousEnd, wordOffset))) {
      creditScope(index);
      start = index;
      startOffset = previousEnd;
      relativeSubject = undefined;
    }
    const isSubordinate = boundaries[index];
    if (!isSubordinate) {
      if (!SPEAKING_COORDINATOR.test(text)) continue;
      const rightEnd = words.findIndex((word, i) => i > index && (boundaries[i] || SPEAKING_COORDINATOR.test(word.text)));
      if (!startsCoordinatedClause(words.slice(start, index), words.slice(index + 1, rightEnd < 0 ? undefined : rightEnd), spans, relativeSubject)) continue;
    }

    creditScope(index);
    start = index + 1;
    if (text === "so" && words[start]?.text === "that") start += 1;
    startOffset = words[start - 1]!.end;
    const first = words.slice(start).find(({ text: word }) => !isSpokenAdverbCue(word))?.text ?? "";
    relativeSubject = SPEAKING_RELATIVE_SUBJECT.test(text) &&
      (isSpokenVerb(first) || SPEAKING_MODAL.test(first) || SPEAKING_REGULAR_PAST.test(first)) ? text : undefined;
  }
  creditScope(words.length);
  return contextual;
}

function cleanSpokenCollocations(rawCollocations: readonly string[]): string[] {
  if (!isDenseIeltsArray(rawCollocations, isNonBlankIeltsString)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawCollocations) {
    const trimmed = item.trim();
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
  const sourcePromptId = readIeltsPromptId(argument.promptId);
  if (!sourcePromptId) throw new TypeError("Invalid IELTS Speaking prompt ID");
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
    seedId: getSpeakingSeedId(sourcePromptId, sourceDraftId),
    cartridgeId: IELTS_CARTRIDGE_ID,
    sourcePromptId,
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

export function getSpeakingSeedId(promptId: string, draftId: string): string {
  return `speaking-p3-${promptId}-${draftId}`;
}

export function classifySpeakingPace(
  durationSeconds: number | null,
  window: { readonly min: number; readonly max: number },
): IeltsSpeakingPaceStatus {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return "invalid_duration";
  }
  if (durationSeconds < window.min) return "too_short";
  if (durationSeconds > window.max) return "over_time";
  return "on_target";
}

export function hasStiffWrittenSpeakingConnector(text: string): boolean {
  return /\b(furthermore|moreover|henceforth|in conclusion)\b/iu.test(text);
}

export function getSpeakingTargets(collocations: readonly string[]): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  if (!isDenseIeltsArray(collocations, isNonBlankIeltsString)) return targets;
  for (const collocation of collocations) {
    const phrase = collocation.trim();
    const key = phrase.toLowerCase().replace(/\s+/gu, " ");
    const existing = targets.get(key);
    if (!existing || compareText(phrase, existing) < 0) targets.set(key, phrase);
  }
  return new Map([...targets].sort(([a], [b]) => compareText(a, b)));
}

type SpeakingCandidate = MatchRange & {
  readonly paragraphIndex: 0;
  readonly sentence: GroundedSentence;
};

function allocateSpeakingEvidence(sentences: readonly GroundedSentence[], targets: ReadonlyMap<string, string>) {
  const patterns = [...targets].map(([target, phrase]) => ({ target, regex: buildPhraseRegex(phrase) }));
  const candidates = new Map([...targets.keys()].map((target) => [target, [] as SpeakingCandidate[]]));
  const observed = new Set<string>();

  for (const sentence of sentences) {
    const spans = patterns.flatMap(({ target, regex }) =>
      Array.from(sentence.text.matchAll(regex), (match) => {
        observed.add(target);
        const start = sentence.startOffset + match.index;
        return { target, start, end: start + match[0].length };
      }),
    ).sort((a, b) => a.start - b.start || b.end - a.end || compareText(a.target, b.target));

    for (const clause of sentence.clauses) {
      for (const part of clause.spokenParts) {
        const matches = spans.filter(({ start, end }) => start >= part.startOffset && end <= part.endOffset);
        if (matches.length === 0) continue;
        const local = matches.map(({ target, start, end }) => ({
          target,
          start: start - part.startOffset,
          end: end - part.startOffset,
        }));
        for (const { target, start, end } of contextualSpokenTargets(part.text, local)) {
          candidates.get(target)!.push({
            paragraphIndex: 0, start: part.startOffset + start, end: part.startOffset + end, sentence,
          });
        }
      }
    }
  }
  return {
    allocated: allocateIeltsSpans(candidates),
    hasBareTargetPaste: [...observed].some((target) => candidates.get(target)!.length === 0),
  };
}

export function hasRequiredWritingReceipt(seed: IeltsSpeakingPart3Seed): boolean {
  const promptId = readIeltsPromptId(seed.sourcePromptId);
  if (!promptId) return false;
  if (!seed.requiresVerifiedReceipt) return true;
  const receipt = seed.verifiedWritingReceipt;
  if (
    !isVerifiedWritingReceipt(receipt, {
      expectedPromptId: promptId,
      expectedDraftId: seed.sourceDraftId,
    })
  ) {
    return false;
  }
  return (
    receipt.cartridgeId === seed.cartridgeId &&
    (seed.verifiedTransferIds === undefined ||
      (isDenseIeltsArray(seed.verifiedTransferIds, isNonBlankIeltsString) &&
        seed.verifiedTransferIds.includes(receipt.receiptId)))
  );
}

type SpeakingEvaluationContext = Required<NonNullable<IeltsSpeakingFeedbackReceipt["evaluationContext"]>>;

export function getSpeakingEvaluationContext(seed: IeltsSpeakingPart3Seed): SpeakingEvaluationContext {
  const { min, max } = seed.timeWindowSeconds;
  return {
    timeWindowSeconds: { min, max },
    writingReceiptEligible: hasRequiredWritingReceipt(seed),
    targetSpokenCollocations: [...getSpeakingTargets(seed.targetSpokenCollocations).values()],
  };
}

function analyzeSpeakingRetelling(
  rawTranscript: string,
  durationSeconds: number | null,
  assisted: boolean,
  evaluationContext: SpeakingEvaluationContext,
) {
  const prose = maskIeltsMarkup(rawTranscript);
  const trimmedTranscript = prose.trim();
  const wordCount = countProseWords(trimmedTranscript);
  const paceStatus = classifySpeakingPace(durationSeconds, evaluationContext.timeWindowSeconds);
  const sentences = wordCount > 0 ? segmentIeltsText(prose) : [];
  const paragraphs = [prose];
  const memorizedTemplateHits = detectMemorizedTemplates(paragraphs);
  const hasStuffing = hasMemorizedTemplateStuffing(memorizedTemplateHits);
  const hasLowEntropy = detectLowEntropyStuffing(paragraphs, [sentences]);
  const targets = getSpeakingTargets(evaluationContext.targetSpokenCollocations);
  const { allocated, hasBareTargetPaste } = allocateSpeakingEvidence(sentences, targets);

  const transferredCollocations: string[] = [];
  const pendingCollocations: string[] = [];
  const matchedSentenceByCollocation = new Map<string, GroundedSentence>();
  for (const [target, expression] of targets) {
    const match = allocated.get(target);
    if (match) {
      transferredCollocations.push(expression);
      matchedSentenceByCollocation.set(expression, match.sentence);
    } else {
      pendingCollocations.push(expression);
    }
  }

  const targetCount = targets.size;
  const requiredTransferred = targetCount > 0 ? Math.min(2, targetCount) : 1;
  const hasEnoughTransfer = transferredCollocations.length >= requiredTransferred;
  const hasEnoughWords = wordCount >= MIN_VERIFIED_SPEAKING_WORDS;
  const hasStiffWrittenConnector = hasStiffWrittenSpeakingConnector(trimmedTranscript);
  const masteryQualified =
    !assisted &&
    evaluationContext.writingReceiptEligible &&
    paceStatus === "on_target" &&
    hasEnoughTransfer &&
    hasEnoughWords &&
    !hasBareTargetPaste &&
    !hasStuffing &&
    !hasLowEntropy &&
    !hasStiffWrittenConnector;

  return {
    prose, trimmedTranscript, wordCount, paceStatus, sentences, memorizedTemplateHits,
    hasStuffing, hasLowEntropy, targetCount, transferredCollocations, pendingCollocations,
    matchedSentenceByCollocation, hasBareTargetPaste, requiredTransferred, hasEnoughTransfer,
    hasEnoughWords, hasStiffWrittenConnector, masteryQualified,
  };
}

export function matchesSpeakingCollocations(stored: readonly string[], expected: readonly string[]): boolean {
  return isDenseIeltsArray(stored, isNonBlankIeltsString) &&
    stored.length === expected.length &&
    expected.every((expression) => stored.includes(expression));
}

/** Recomputes the mastery claim and its transferred/pending partition from the transcript. */
export function hasVerifiedSpeakingRetelling(
  receipt: IeltsSpeakingFeedbackReceipt,
  context: SpeakingEvaluationContext,
): boolean {
  const targets = context.targetSpokenCollocations;
  const storedTargets = receipt.evaluationContext?.targetSpokenCollocations;
  if (!matchesSpeakingCollocations(targets, [...getSpeakingTargets(targets).values()]) ||
      (storedTargets !== undefined && !matchesSpeakingCollocations(storedTargets, targets))) {
    return false;
  }
  const retelling = analyzeSpeakingRetelling(
    receipt.sourceTranscript, receipt.durationSeconds, receipt.assisted, context,
  );
  return retelling.masteryQualified &&
    retelling.wordCount === receipt.wordCount &&
    retelling.paceStatus === receipt.paceStatus &&
    matchesSpeakingCollocations(receipt.transferredCollocations, retelling.transferredCollocations) &&
    matchesSpeakingCollocations(receipt.pendingCollocations, retelling.pendingCollocations);
}

/**
 * Evaluates a learner's Speaking Part 3 retelling with contextual phrase evidence and
 * exact UTF-16 citation offsets.
 */
export function evaluateSpeakingRetelling(
  input: IeltsSpeakingRetellingInput,
): IeltsSpeakingFeedbackReceipt {
  const sourcePromptId = readIeltsPromptId(input.seed.sourcePromptId);
  if (!sourcePromptId) throw new TypeError("Invalid IELTS Speaking prompt ID");
  const rawTranscript = input.transcript;
  const evaluationContext = getSpeakingEvaluationContext(input.seed);
  const { min, max } = evaluationContext.timeWindowSeconds;
  const timeWindowLabel = `${min}–${max} 秒`;
  const safeDurationSeconds =
    Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? input.durationSeconds
      : null;
  const {
    prose, trimmedTranscript, wordCount, paceStatus, sentences, memorizedTemplateHits,
    hasStuffing, hasLowEntropy, targetCount, transferredCollocations, pendingCollocations,
    matchedSentenceByCollocation, hasBareTargetPaste, requiredTransferred, hasEnoughTransfer,
    hasEnoughWords, hasStiffWrittenConnector, masteryQualified,
  } = analyzeSpeakingRetelling(
    rawTranscript, safeDurationSeconds, input.assisted, evaluationContext,
  );
  const hasSpokenSignpost =
    /\b(personally|to be honest|that said|on the other hand|in the long run|the main reason|admittedly|for instance|for example|on top of that)\b/iu.test(
      trimmedTranscript,
    );
  const hasComplexClause =
    /\b(while|although|even though|whereas|which|because|if|unless)\b/iu.test(
      trimmedTranscript,
    );
  // Build exact, untrimmed-offset evidence quotes: 1 fluency quote + 1 quote per credited target hit.
  const evidenceQuotes: IeltsSpeakingEvidenceQuote[] = [];
  const boundaries = graphemeBoundaries(rawTranscript);
  function groundQuote(sentence: GroundedSentence) {
    const range = trimToProseGraphemes(prose, boundaries, sentence.startOffset, sentence.endOffset);
    return range && { ...range, quote: rawTranscript.slice(range.startOffset, range.endOffset) };
  }

  const groundedQuotes = sentences.map(groundQuote).filter((quote) => quote !== null);
  const [firstQuote] = groundedQuotes;
  if (firstQuote) {
    evidenceQuotes.push({
      id: `${input.seed.seedId}-sp-fluency`,
      signal: "fluencyCohesion",
      ...firstQuote,
      diagnosis:
        hasStiffWrittenConnector
          ? "转写中带有明显书面连接词（如 Furthermore / In conclusion），口语中改用 That said / On top of that 会更自然。"
          : hasSpokenSignpost && paceStatus === "on_target"
            ? "开头直接切入政策权衡并具备清晰口语过渡线索，时长控制在目标窗口内。"
            : paceStatus === "too_short"
              ? `回应偏短（不足 ${min} 秒），建议补一个具体城市或通勤者视角把观点说透。`
              : paceStatus === "invalid_duration"
                ? `未提供有效作答时长，无法确认节奏控制，请在 ${timeWindowLabel}内重新计时复述。`
                : "可进一步用口语路标词（Personally / That said / For instance）串联观点的正反两面。",
      upgradeRewrite:
        "Personally, I think the core tension is that drivers feel highway widening right away, whereas urban rail takes years to pay off.",
    });

    if (transferredCollocations.length > 0) {
      // Emit one grounded citation for EVERY credited target hit!
      transferredCollocations.forEach((expr, idx) => {
        const matchedQuote = groundQuote(matchedSentenceByCollocation.get(expr)!);
        if (!matchedQuote) return;
        evidenceQuotes.push({
          id: `${input.seed.seedId}-sp-lexical-${idx + 1}`,
          signal: "lexicalTransfer",
          ...matchedQuote,
          matchedExpression: expr,
          diagnosis: `该句已自然迁移写作目标表达（${expr}），使口语论述更具体。`,
          upgradeRewrite:
            pendingCollocations.length > 0
              ? `下一轮可继续把尚未用到的表达带入口语：${pendingCollocations.slice(0, 2).join(", ")}。`
              : "继续保持这种把精准搭配融入自然口语句式的表达习惯，避免生硬背诵书面语。",
        });
      });
    } else if (targetCount > 0) {
      const longestQuote = groundedQuotes.reduce(
        (longest, quote) => quote.quote.length > longest.quote.length ? quote : longest,
        firstQuote,
      );
      evidenceQuotes.push({
        id: `${input.seed.seedId}-sp-lexical-0`,
        signal: "lexicalTransfer",
        ...longestQuote,
        diagnosis: hasBareTargetPaste
          ? "仅检测到孤立拼贴的目标词组片段，尚未融入完整口语句子语境。"
          : "本次转写尚未命中任何目标活性搭配，建议结合提示词把写作二稿中的核心搭配自然说出来。",
        upgradeRewrite: `可尝试在完整从句中自然带出：${pendingCollocations.slice(0, 2).join(", ")}。`,
      });
    }
  }

  const hasEnoughTargets = targetCount > 0;
  const hasValidPace = paceStatus === "on_target";
  const hasWritingReceipt = evaluationContext.writingReceiptEligible;

  const epistemicStatus = masteryQualified
    ? "rubric_verified_evidence"
    : "practice_feedback";

  let epistemicReason: string;
  if (masteryQualified) {
    epistemicReason = input.freshPromptTransfer
      ? `独立在 ${timeWindowLabel}内完成新题口语迁移并命中 ${transferredCollocations.length} 组目标搭配，已确认为口语转写迁移证据（不含语音发音评分）。`
      : `独立在 ${timeWindowLabel}内完成 Part 3 追问复述并命中 ${transferredCollocations.length} 组目标搭配，已确认为口语转写迁移证据（不含语音发音评分）。`;
  } else if (wordCount === 0) {
    epistemicReason = "请先输入包含英文单词的口语复述或转写，再生成反馈。";
  } else if (input.assisted) {
    epistemicReason = "本次口语复述参照了写作稿件或提示，仅作转写练习反馈，不计入正式掌握度。";
  } else if (!hasWritingReceipt) {
    epistemicReason = "这道口语题需先通过来源写作稿件的迁移复核，本次仅作转写练习反馈。";
  } else if (paceStatus === "invalid_duration") {
    epistemicReason = `作答时长无效或缺失，无法确认是否落在 ${timeWindowLabel}有效区间，本次仅作转写练习反馈。`;
  } else if (!hasValidPace) {
    epistemicReason =
      paceStatus === "too_short"
        ? `当前作答时长（${safeDurationSeconds} 秒）低于 ${timeWindowLabel}有效窗口，本次仅作转写练习反馈。`
        : `当前作答时长（${safeDurationSeconds} 秒）超出 ${timeWindowLabel}有效窗口，建议精炼观点后重新复述。`;
  } else if (!hasEnoughTargets) {
    epistemicReason = "当前题卡未配置目标口语迁移表达，无法完成迁移检核，仅作转写练习反馈。";
  } else if (hasBareTargetPaste) {
    epistemicReason = "检测到孤立拼贴的目标词组片段，请将目标表达自然融入完整口语句子后再复核。";
  } else if (hasStuffing || hasLowEntropy) {
    epistemicReason = "检测到模板套话或低信息量重复填充，本次仅作转写练习反馈，不计入正式掌握度。";
  } else if (hasStiffWrittenConnector) {
    epistemicReason = "检测到偏生硬的书面连接词（如 Furthermore / In conclusion），改用自然口语衔接后可重新复核。";
  } else if (!hasEnoughWords) {
    epistemicReason = `当前转写有效词数为 ${wordCount} 词，低于 ${timeWindowLabel}口语展开门槛（${MIN_VERIFIED_SPEAKING_WORDS} 词），暂作转写练习反馈。`;
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
      rating:
        !hasEnoughTargets || transferredCollocations.length === 0 || hasBareTargetPaste
          ? "needs_work"
          : hasEnoughTransfer && !hasStuffing
            ? "strong"
            : "developing",
      note: !hasEnoughTargets
        ? "未设定目标迁移搭配，当前仅记录基础词汇使用。"
        : hasBareTargetPaste
          ? "检测到脱离完整句子的孤立词组拼贴，需融入自然口语从句才计作迁移。"
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
          ? `时长无效，需记录有效的 ${timeWindowLabel}计时结果。`
          : paceStatus === "on_target"
            ? `作答 ${safeDurationSeconds} 秒，落在 ${timeWindowLabel}目标区间内。`
            : paceStatus === "too_short"
              ? `作答 ${safeDurationSeconds} 秒，低于 ${min} 秒下限，观点展开偏简略。`
              : `作答 ${safeDurationSeconds} 秒，超过 ${max} 秒上限，建议收紧收尾。`,
    },
  };

  return {
    receiptId: `speaking-receipt-${input.seed.seedId}`,
    cartridgeId: IELTS_CARTRIDGE_ID,
    seedId: input.seed.seedId,
    sourcePromptId,
    sourceTranscript: rawTranscript,
    assisted: input.assisted,
    evaluationContext,
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
