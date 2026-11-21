"use client";

import { useMemo, useState } from "react";
import {
  evaluateSpeakingRetelling,
  getSpeakingEvaluationContext,
  hasVerifiedSpeakingRetelling,
  type IeltsRubricReceipt,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPart3Seed,
} from "./domain-bridge";
import {
  IELTS_LEARNER_SPEAKING_SEED,
  IELTS_WRITING_SPEAKING_FIXTURE,
} from "./ielts-fixtures";
import {
  EPISTEMIC_BADGE_META,
  SPEAKING_PACE_META,
  SPEAKING_SIGNAL_ORDER,
  SPEAKING_SIGNAL_RATING_META,
  buildExposedGuidanceMatcher,
  collectAssistedFingerprints,
  matchesAssistedFingerprint,
  matchesExposedGuidance,
} from "./workbench-model";

export type IeltsSpeakingTransferCardProps = {
  readonly seed?: IeltsSpeakingPart3Seed;
  readonly verifiedWritingReceipt?: IeltsRubricReceipt;
  readonly initialAttemptPromptId?: string;
  readonly initialTranscript?: string;
  readonly initialDurationSeconds?: number;
  readonly initialReceipt?: IeltsSpeakingFeedbackReceipt;
  readonly sampleTranscript?: string;
  readonly demoFixtureMode?: boolean;
  readonly onEvaluated?: (receipt: IeltsSpeakingFeedbackReceipt) => void;
};

function snapshotReceipt(receipt: IeltsSpeakingFeedbackReceipt): string {
  // Persisted receipt objects can return with their fields in a different order.
  return JSON.stringify(receipt, (_key: string, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  });
}

export function IeltsSpeakingTransferCard({
  seed: providedSeed,
  verifiedWritingReceipt: providedVerifiedWritingReceipt,
  initialAttemptPromptId,
  initialTranscript,
  initialDurationSeconds,
  initialReceipt,
  sampleTranscript,
  demoFixtureMode = false,
  onEvaluated,
}: IeltsSpeakingTransferCardProps) {
  const demo = IELTS_WRITING_SPEAKING_FIXTURE;
  const isDemoPreview = demoFixtureMode === true;
  const defaultLearnerSeed: IeltsSpeakingPart3Seed = {
    ...IELTS_LEARNER_SPEAKING_SEED,
    verifiedWritingReceipt: providedVerifiedWritingReceipt,
  };
  const seed: IeltsSpeakingPart3Seed = providedSeed
    ? providedVerifiedWritingReceipt !== undefined
      ? { ...providedSeed, verifiedWritingReceipt: providedVerifiedWritingReceipt }
      : providedSeed
    : isDemoPreview
      ? demo.speakingSeed
      : defaultLearnerSeed;
  const useDemoFixture =
    isDemoPreview &&
    providedSeed === undefined &&
    initialTranscript === undefined &&
    initialDurationSeconds === undefined &&
    initialReceipt === undefined;
  const candidateReceipt = useDemoFixture ? demo.initialSpeakingReceipt : initialReceipt;
  const receiptBelongsToSeed =
    candidateReceipt !== undefined &&
    candidateReceipt.seedId === seed.seedId &&
    typeof candidateReceipt.sourcePromptId === "string" &&
    candidateReceipt.sourcePromptId === seed.sourcePromptId;
  const hasForeignReceipt = candidateReceipt !== undefined && !receiptBelongsToSeed;
  const hasForeignAttemptPromptId =
    initialAttemptPromptId !== undefined && initialAttemptPromptId !== seed.sourcePromptId;
  const hasExplicitPromptBinding =
    initialAttemptPromptId === seed.sourcePromptId || receiptBelongsToSeed;

  // Guard against a parent switching seed.sourcePromptId before clearing transcript-only
  // state (initialReceipt === undefined, initialAttemptPromptId omitted).
  const [promptSwitchGuard, setPromptSwitchGuard] = useState<{
    readonly sourcePromptId: string;
    readonly staleTranscript: string | undefined;
    readonly staleDuration: number | undefined;
    readonly active: boolean;
  }>(() => ({
    sourcePromptId: seed.sourcePromptId,
    staleTranscript: undefined,
    staleDuration: undefined,
    active: false,
  }));
  const switchedPrompt = promptSwitchGuard.sourcePromptId !== seed.sourcePromptId;
  if (switchedPrompt) {
    setPromptSwitchGuard({
      sourcePromptId: seed.sourcePromptId,
      staleTranscript: hasExplicitPromptBinding ? undefined : initialTranscript,
      staleDuration: hasExplicitPromptBinding ? undefined : initialDurationSeconds,
      active: !hasExplicitPromptBinding,
    });
  } else if (
    promptSwitchGuard.active &&
    (hasExplicitPromptBinding ||
      (initialTranscript !== promptSwitchGuard.staleTranscript &&
        initialDurationSeconds !== promptSwitchGuard.staleDuration))
  ) {
    setPromptSwitchGuard({
      sourcePromptId: seed.sourcePromptId,
      staleTranscript: undefined,
      staleDuration: undefined,
      active: false,
    });
  }

  const rejectStaleTranscript =
    hasForeignReceipt ||
    hasForeignAttemptPromptId ||
    (!hasExplicitPromptBinding &&
      (switchedPrompt ||
        (promptSwitchGuard.active && initialTranscript === promptSwitchGuard.staleTranscript)));
  const rejectStaleDuration =
    hasForeignReceipt ||
    hasForeignAttemptPromptId ||
    (!hasExplicitPromptBinding &&
      (switchedPrompt ||
        (promptSwitchGuard.active && initialDurationSeconds === promptSwitchGuard.staleDuration)));

  const startingTranscript = useDemoFixture
    ? demo.initialSpeakingTranscript
    : rejectStaleTranscript
      ? ""
      : (initialTranscript ?? "");
  const startingDuration = useDemoFixture
    ? demo.initialSpeakingDurationSeconds
    : rejectStaleDuration
      ? undefined
      : initialDurationSeconds;
  const scaffoldSampleTranscript =
    sampleTranscript ?? (providedSeed === undefined ? demo.initialSpeakingTranscript : undefined);
  const seedFixtureSamplesUpfront =
    !isDemoPreview &&
    ((providedSeed === undefined && initialTranscript === undefined && initialReceipt === undefined) ||
      (sampleTranscript !== undefined && sampleTranscript !== startingTranscript));
  const attemptKey = JSON.stringify([
    isDemoPreview,
    seed.seedId,
    seed.cartridgeId,
    seed.sourcePromptId,
  ]);
  const matchedSeedReceipt = receiptBelongsToSeed ? candidateReceipt : null;
  return (
    <SpeakingAttempt
      key={attemptKey}
      seed={seed}
      isDemoPreview={isDemoPreview}
      scaffoldSampleTranscript={scaffoldSampleTranscript}
      seedFixtureSamplesUpfront={seedFixtureSamplesUpfront}
      startingTranscript={startingTranscript}
      seedReceipt={matchedSeedReceipt}
      external={{
        transcript: useDemoFixture
          ? demo.initialSpeakingTranscript
          : rejectStaleTranscript
            ? undefined
            : initialTranscript,
        durationSeconds: startingDuration,
        receiptSnapshot: matchedSeedReceipt ? snapshotReceipt(matchedSeedReceipt) : undefined,
      }}
      onEvaluated={onEvaluated}
    />
  );
}

type ExternalSpeakingInput = {
  readonly transcript: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly receiptSnapshot: string | undefined;
};

function collectSpeakingReceiptGuidance(
  seed: IeltsSpeakingPart3Seed,
  receipt: IeltsSpeakingFeedbackReceipt | null,
): string[] {
  if (!receipt || receipt.wordCount <= 0) return [];
  const rewrites = receipt.evidenceQuotes
    .map((quote) => quote.upgradeRewrite.trim())
    .filter(Boolean);
  return [
    ...new Set([
      ...seed.argumentBridgeCues.filter((cue) => cue.trim().length > 0),
      ...rewrites,
    ]),
  ];
}

function isSpeakingReceiptVisibleForAttempt(
  seed: IeltsSpeakingPart3Seed,
  receipt: IeltsSpeakingFeedbackReceipt | null,
  transcript: string,
  durationSeconds: number | null,
  assisted: boolean,
  targets: readonly string[],
  context: ReturnType<typeof getSpeakingEvaluationContext>,
): receipt is IeltsSpeakingFeedbackReceipt {
  if (!receipt) return false;
  const evaluatedTargets = [...receipt.transferredCollocations, ...receipt.pendingCollocations];
  const evaluatedContext = receipt.evaluationContext;
  return (
    receipt.seedId === seed.seedId &&
    typeof receipt.sourcePromptId === "string" &&
    receipt.sourcePromptId === seed.sourcePromptId &&
    receipt.sourceTranscript === transcript &&
    receipt.durationSeconds === durationSeconds &&
    receipt.assisted === assisted &&
    evaluatedContext?.timeWindowSeconds.min === context.timeWindowSeconds.min &&
    evaluatedContext.timeWindowSeconds.max === context.timeWindowSeconds.max &&
    evaluatedContext.writingReceiptEligible === context.writingReceiptEligible &&
    evaluatedTargets.length === targets.length &&
    targets.every((target) => evaluatedTargets.includes(target)) &&
    (receipt.epistemicStatus !== "rubric_verified_evidence" ||
      (!receipt.assisted &&
        receipt.masteryQualified &&
        receipt.countsTowardMastery &&
        hasVerifiedSpeakingRetelling(receipt, context)))
  );
}

function SpeakingAttempt({
  seed,
  isDemoPreview,
  scaffoldSampleTranscript,
  seedFixtureSamplesUpfront,
  startingTranscript,
  seedReceipt,
  external,
  onEvaluated,
}: {
  readonly seed: IeltsSpeakingPart3Seed;
  readonly isDemoPreview: boolean;
  readonly scaffoldSampleTranscript: string | undefined;
  readonly seedFixtureSamplesUpfront: boolean;
  readonly startingTranscript: string;
  readonly seedReceipt: IeltsSpeakingFeedbackReceipt | null;
  readonly external: ExternalSpeakingInput;
  readonly onEvaluated: IeltsSpeakingTransferCardProps["onEvaluated"];
}) {
  const scaffoldSources = useMemo(
    () => [scaffoldSampleTranscript ?? "", ...seed.argumentBridgeCues]
      .filter((text) => typeof text === "string" && text.trim().length > 0),
    [scaffoldSampleTranscript, seed.argumentBridgeCues],
  );
  const context = getSpeakingEvaluationContext(seed);
  const targets = context.targetSpokenCollocations;
  const authority = JSON.stringify(context);
  const seedReceiptAssistedSource = seedReceipt?.assisted ? seedReceipt.sourceTranscript.trim() : "";

  const [editedAnswer, setEditedAnswer] = useState<{
    transcript: string;
    durationInput: string;
    assisted: boolean;
  } | null>(null);
  const [localEvaluation, setLocalEvaluation] = useState<{
    authority: string;
    external: ExternalSpeakingInput;
    receiptSnapshot: string;
    receipt: IeltsSpeakingFeedbackReceipt;
  } | null>(null);
  const [hintsRevealed, setHintsRevealed] = useState(false);
  const [attemptAssistedLatched, setAttemptAssistedLatched] = useState(
    () => Boolean(seedReceipt?.assisted),
  );
  const [seenAssistedReceiptSnapshot, setSeenAssistedReceiptSnapshot] = useState<
    string | undefined
  >(() => (seedReceipt?.assisted ? external.receiptSnapshot : undefined));
  const [clearedPersistedReceiptSnapshot, setClearedPersistedReceiptSnapshot] = useState<
    string | undefined
  >(undefined);
  // Unconditional assisted sources (upfront built-in samples & host-loaded assisted receipts).
  const [unconditionalAssistedSources, setUnconditionalAssistedSources] = useState<readonly string[]>(() => {
    const initial: string[] = [];
    if (seedFixtureSamplesUpfront) initial.push(...scaffoldSources);
    if (seedReceiptAssistedSource) initial.push(seedReceiptAssistedSource);
    return [...new Set(initial)];
  });
  // Composer transcripts captured locally while hints/assistance were active; evaluated baseline-aware
  // against unassistedBaselineTexts so revealing hints then resetting never poisons a prior
  // independent verified speech.
  const [capturedAssistedSources, setCapturedAssistedSources] = useState<readonly string[]>(() => []);

  const initialVisibleReceipt = (() => {
    const initialMatching =
      seedReceipt?.sourceTranscript === startingTranscript &&
      (external.durationSeconds === undefined ||
        external.durationSeconds === seedReceipt.durationSeconds)
        ? seedReceipt
        : null;
    const rawDuration = external.durationSeconds ?? initialMatching?.durationSeconds;
    const initialDuration =
      rawDuration != null && Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : null;
    const initialAssisted =
      Boolean(initialMatching?.assisted) ||
      (seedFixtureSamplesUpfront &&
        matchesAssistedFingerprint(startingTranscript, collectAssistedFingerprints(scaffoldSources)));
    return isSpeakingReceiptVisibleForAttempt(
      seed,
      initialMatching,
      startingTranscript,
      initialDuration,
      initialAssisted,
      targets,
      context,
    )
      ? initialMatching
      : null;
  })();

  // Append-only history of explicitly revealed scaffolds & cues shown on screen for this seed.
  const [revealedScaffoldSources, setRevealedScaffoldSources] = useState<readonly string[]>(() => []);
  // Append-only history of cues and quote rewrites actually shown on screen for this seed.
  // Seeded immediately from any initial/restored visible receipt so editing duration or transcript
  // (which hides the receipt) can never erase previously displayed guidance.
  const [exposedGuidanceSources, setExposedGuidanceSources] = useState<readonly string[]>(() =>
    collectSpeakingReceiptGuidance(seed, initialVisibleReceipt),
  );
  const [unassistedBaselineTexts, setUnassistedBaselineTexts] = useState<readonly string[]>(() =>
    initialVisibleReceipt && !initialVisibleReceipt.assisted && startingTranscript.trim().length > 0
      ? [startingTranscript]
      : [],
  );

  const currentlyVisibleScaffolds = useMemo(
    () => (hintsRevealed ? scaffoldSources : []),
    [hintsRevealed, scaffoldSources],
  );
  if (hintsRevealed && currentlyVisibleScaffolds.some((src) => !revealedScaffoldSources.includes(src))) {
    setRevealedScaffoldSources([...new Set([...revealedScaffoldSources, ...currentlyVisibleScaffolds])]);
  }

  if (seedReceipt?.assisted && external.receiptSnapshot !== seenAssistedReceiptSnapshot) {
    setSeenAssistedReceiptSnapshot(external.receiptSnapshot);
    setAttemptAssistedLatched(true);
    if (seedReceiptAssistedSource && !unconditionalAssistedSources.includes(seedReceiptAssistedSource)) {
      setUnconditionalAssistedSources([...unconditionalAssistedSources, seedReceiptAssistedSource]);
    }
    if (editedAnswer && !editedAnswer.assisted) {
      setEditedAnswer({ ...editedAnswer, assisted: true });
    }
  } else if (
    seedReceiptAssistedSource &&
    !unconditionalAssistedSources.includes(seedReceiptAssistedSource)
  ) {
    setUnconditionalAssistedSources([...unconditionalAssistedSources, seedReceiptAssistedSource]);
  }

  const assistedFingerprints = useMemo(
    () =>
      collectAssistedFingerprints([
        ...unconditionalAssistedSources,
        ...(seedReceiptAssistedSource ? [seedReceiptAssistedSource] : []),
      ]),
    [unconditionalAssistedSources, seedReceiptAssistedSource],
  );
  const allExposedGuidanceSources = useMemo(
    () => [
      ...new Set([
        ...exposedGuidanceSources,
        ...revealedScaffoldSources,
        ...capturedAssistedSources,
        ...currentlyVisibleScaffolds,
      ]),
    ],
    [exposedGuidanceSources, revealedScaffoldSources, capturedAssistedSources, currentlyVisibleScaffolds],
  );
  const exposedGuidanceMatcher = useMemo(
    () => buildExposedGuidanceMatcher(allExposedGuidanceSources, unassistedBaselineTexts),
    [allExposedGuidanceSources, unassistedBaselineTexts],
  );

  const isPersistedReceiptCleared =
    clearedPersistedReceiptSnapshot !== undefined &&
    clearedPersistedReceiptSnapshot === external.receiptSnapshot;
  const matchingReceipt =
    !isPersistedReceiptCleared &&
    seedReceipt?.sourceTranscript === startingTranscript &&
    (external.durationSeconds === undefined ||
      external.durationSeconds === seedReceipt.durationSeconds)
      ? seedReceipt
      : null;
  const isStartingStickyAssisted =
    attemptAssistedLatched ||
    matchesAssistedFingerprint(startingTranscript, assistedFingerprints) ||
    matchesExposedGuidance(startingTranscript, exposedGuidanceMatcher);
  const answer = editedAnswer ?? {
    transcript: startingTranscript,
    durationInput: String(external.durationSeconds ?? matchingReceipt?.durationSeconds ?? ""),
    assisted: (matchingReceipt?.assisted ?? false) || isStartingStickyAssisted,
  };
  const { transcript, durationInput } = answer;
  const parsedDuration = durationInput.trim() === "" ? Number.NaN : Number(durationInput);
  const receiptDuration =
    Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;
  const isMatchingAssistedText =
    matchesAssistedFingerprint(transcript, assistedFingerprints) ||
    matchesExposedGuidance(transcript, exposedGuidanceMatcher);
  const isStickyAssisted = attemptAssistedLatched || isMatchingAssistedText;
  const assisted = answer.assisted || isStickyAssisted;
  let evaluatedReceipt = matchingReceipt;
  if (localEvaluation) {
    const baseline = localEvaluation.external;
    const receiptChanged = baseline.receiptSnapshot !== external.receiptSnapshot;
    const hostOwnsAnswer =
      external.receiptSnapshot === localEvaluation.receiptSnapshot &&
      external.transcript === localEvaluation.receipt.sourceTranscript &&
      (external.durationSeconds ?? null) === localEvaluation.receipt.durationSeconds;
    if (hostOwnsAnswer) {
      setEditedAnswer(null);
      setLocalEvaluation(null);
    } else if (
      localEvaluation.authority !== authority ||
      baseline.transcript !== external.transcript ||
      !Object.is(baseline.durationSeconds, external.durationSeconds) ||
      (receiptChanged && localEvaluation.receiptSnapshot !== external.receiptSnapshot)
    ) {
      setLocalEvaluation(null);
    } else {
      evaluatedReceipt = localEvaluation.receipt;
      // Acknowledging the emitted receipt makes a subsequent removal a new change.
      if (receiptChanged) setLocalEvaluation({ ...localEvaluation, external });
    }
  }
  const receipt = isSpeakingReceiptVisibleForAttempt(
    seed,
    evaluatedReceipt,
    transcript,
    receiptDuration,
    assisted,
    targets,
    context,
  )
    ? evaluatedReceipt
    : null;

  const hasSubstantiveSubmission = receipt !== null && receipt.wordCount > 0;
  const displayedEpistemicStatus =
    receipt === null
      ? null
      : isDemoPreview
        ? "practice_feedback"
        : receipt.epistemicStatus;
  const epistemicMeta = displayedEpistemicStatus
    ? EPISTEMIC_BADGE_META[displayedEpistemicStatus]
    : null;
  const paceMeta = receipt ? SPEAKING_PACE_META[receipt.paceStatus] : null;

  const displayedPostSubmitSources = useMemo(
    () => (hasSubstantiveSubmission ? collectSpeakingReceiptGuidance(seed, receipt) : []),
    [hasSubstantiveSubmission, receipt, seed],
  );
  // Monotonically latch any newly visible receipt's cues/rewrites BEFORE any user edit can hide it.
  if (hasSubstantiveSubmission && displayedPostSubmitSources.length > 0) {
    const missing = displayedPostSubmitSources.filter(
      (source) => !exposedGuidanceSources.includes(source),
    );
    if (missing.length > 0) {
      setExposedGuidanceSources([...exposedGuidanceSources, ...missing]);
    }
    if (
      receipt &&
      !receipt.assisted &&
      receipt.sourceTranscript.trim().length > 0 &&
      !unassistedBaselineTexts.includes(receipt.sourceTranscript)
    ) {
      setUnassistedBaselineTexts([...unassistedBaselineTexts, receipt.sourceTranscript]);
    }
  }

  function handleRevealScaffold() {
    const currentTrimmed = transcript.trim();
    setHintsRevealed(true);
    setAttemptAssistedLatched(true);
    if (scaffoldSources.length > 0) {
      setRevealedScaffoldSources((current) => [...new Set([...current, ...scaffoldSources])]);
    }
    if (displayedPostSubmitSources.length > 0) {
      setExposedGuidanceSources((current) => [...new Set([...current, ...displayedPostSubmitSources])]);
    }
    if (currentTrimmed) {
      setCapturedAssistedSources((current) => [...new Set([...current, currentTrimmed])]);
    }
    setEditedAnswer((current) => ({ ...(current ?? answer), assisted: true }));
    setLocalEvaluation(null);
  }

  function handleResetForFreshAttempt() {
    // Preserve unassistedBaselineTexts and keep exposed/revealed/captured sources in baseline-aware
    // lists so retyping an earlier independent speech (even after Reveal -> Reset) is never falsely
    // marked assisted, while pasting any novel post-submit cue/rewrite, revealed scaffold, or novel
    // assisted transcript still locks assistance.
    if (displayedPostSubmitSources.length > 0) {
      setExposedGuidanceSources((current) => [...new Set([...current, ...displayedPostSubmitSources])]);
    }
    if (hintsRevealed && scaffoldSources.length > 0) {
      setRevealedScaffoldSources((current) => [...new Set([...current, ...scaffoldSources])]);
    }
    if (hintsRevealed || attemptAssistedLatched || assisted) {
      const currentTrimmed = transcript.trim();
      if (currentTrimmed) {
        setCapturedAssistedSources((current) => [...new Set([...current, currentTrimmed])]);
      }
    }
    setEditedAnswer({ transcript: "", durationInput: "", assisted: false });
    setLocalEvaluation(null);
    setHintsRevealed(false);
    setAttemptAssistedLatched(false);
    setSeenAssistedReceiptSnapshot(seedReceipt?.assisted ? external.receiptSnapshot : undefined);
    setClearedPersistedReceiptSnapshot(external.receiptSnapshot);
  }

  function handleEvaluate() {
    const mergedExposedSources = [
      ...new Set([...allExposedGuidanceSources, ...displayedPostSubmitSources]),
    ];
    const activeExposedMatcher =
      mergedExposedSources.length > allExposedGuidanceSources.length
        ? buildExposedGuidanceMatcher(mergedExposedSources, unassistedBaselineTexts)
        : exposedGuidanceMatcher;
    const matchedExposed = matchesExposedGuidance(transcript, activeExposedMatcher);
    const effectiveAssisted = isDemoPreview || assisted || matchedExposed;

    const nextReceipt = evaluateSpeakingRetelling({
      seed,
      transcript,
      durationSeconds: parsedDuration,
      assisted: effectiveAssisted,
    });
    if (nextReceipt.assisted) {
      setAttemptAssistedLatched(true);
      setEditedAnswer((current) =>
        current && !current.assisted ? { ...current, assisted: true } : current,
      );
      const trimmedTranscript = transcript.trim();
      if (trimmedTranscript) {
        setCapturedAssistedSources((current) => [...new Set([...current, trimmedTranscript])]);
      }
    }
    // A substantive submission displays argumentBridgeCues and evidence quote rewrites on screen.
    // Latch them monotonically so any subsequent edit, duration change, or reset retry checks against them.
    if (nextReceipt.wordCount > 0) {
      const nextDisplayed = collectSpeakingReceiptGuidance(seed, nextReceipt);
      if (nextDisplayed.length > 0 || displayedPostSubmitSources.length > 0) {
        setExposedGuidanceSources((current) => [
          ...new Set([...current, ...displayedPostSubmitSources, ...nextDisplayed]),
        ]);
      }
      if (!nextReceipt.assisted && nextReceipt.sourceTranscript.trim().length > 0) {
        setUnassistedBaselineTexts((current) =>
          current.includes(nextReceipt.sourceTranscript)
            ? current
            : [...current, nextReceipt.sourceTranscript],
        );
      }
    }
    setLocalEvaluation({
      authority,
      external,
      receiptSnapshot: snapshotReceipt(nextReceipt),
      receipt: nextReceipt,
    });
    onEvaluated?.(nextReceipt);
  }

  return (
    <section
      aria-label="雅思口语 Part 3 迁移复述卡片"
      className="mx-auto w-full max-w-4xl space-y-5 rounded-panel border border-line bg-surface p-5 text-text shadow-card sm:p-6"
    >
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div className="space-y-1">
          <p className="text-cap font-medium text-text-2">
            Speaking Part 3 · 写作观点口语迁移（{seed.timeWindowSeconds.min}–
            {seed.timeWindowSeconds.max} 秒）
          </p>
          <h2 className="text-title font-semibold text-text">
            从二稿核心主张出发，完成一轮自然口语追问复述
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            data-speaking-mode="transcript_practice_feedback"
            className="rounded-tile border border-line bg-surface-2 px-3 py-1 text-meta font-medium text-text"
          >
            转写练习反馈 / 迁移检核
          </span>
          {receipt && epistemicMeta && displayedEpistemicStatus && (
            <span
              data-speaking-epistemic={displayedEpistemicStatus}
              data-demo-preview={isDemoPreview ? "true" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-meta font-medium ${epistemicMeta.badgeClass}`}
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-pill ${epistemicMeta.dotClass}`}
              />
              {isDemoPreview
                ? "示例预览 · 仅作参考，不计入正式掌握度"
                : epistemicMeta.speakingLabel}
            </span>
          )}
        </div>
      </header>

      {receipt && (
        <p
          data-pronunciation-disclaimer
          className="rounded-ctl border border-line bg-surface-2/70 px-3.5 py-2.5 text-meta text-text-2"
        >
          {receipt.assessmentScopeNote}
        </p>
      )}

      {/* Examiner Follow-Up Prompt */}
      <div className="space-y-2 rounded-tile border border-line bg-bg p-4">
        <p className="text-cap font-medium text-text-3">考官追问（Part 3）</p>
        <p className="font-reading text-read-lg leading-7 text-text">
          {seed.followUpQuestion}
        </p>
        <p className="text-meta text-text-2">{seed.followUpQuestionZh}</p>

        {(hasSubstantiveSubmission || isDemoPreview) && (
          <ul className="mt-2 space-y-1 border-t border-line pt-2.5 text-meta text-text-2">
            {seed.argumentBridgeCues.map((cue, idx) => (
              <li key={idx} className="flex gap-2">
                <span className="font-mono text-cap text-text-3">{idx + 1}.</span>
                <span>{cue}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Active Target Spoken Expressions */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-ui font-semibold text-text">
            本轮目标活性搭配（来自写作二稿）
          </h3>
          <span className="text-meta tabular-nums text-text-2">
            已迁移 {receipt?.transferredCollocations.length ?? 0} /{" "}
            {targets.length}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {targets.map((phrase) => {
            const matched = receipt?.transferredCollocations.includes(phrase) ?? false;
            return (
              <span
                key={phrase}
                data-collocation-state={matched ? "transferred" : "pending"}
                className={`rounded-pill border px-3 py-1 font-reading text-meta transition-colors ${
                  matched
                    ? "border-accent/35 bg-accent-soft font-medium text-accent"
                    : "border-line bg-surface-2 text-text-2"
                }`}
              >
                {matched ? "✓ " : ""}
                {phrase}
              </span>
            );
          })}
        </div>
      </div>

      {/* Spoken Transcript & Duration Composer */}
      <div className="space-y-3 rounded-tile border border-line bg-bg p-4">
        <label className="block space-y-1.5">
          <span className="text-meta font-medium text-text-2">
            口语复述要点 / 语音转写记录
          </span>
          <textarea
            aria-label="口语复述记录输入框"
            rows={5}
            value={transcript}
            onChange={(event) => {
              const nextTranscript = event.target.value;
              const mergedExposedSources =
                displayedPostSubmitSources.length > 0
                  ? [...new Set([...allExposedGuidanceSources, ...displayedPostSubmitSources])]
                  : allExposedGuidanceSources;
              if (displayedPostSubmitSources.some((s) => !exposedGuidanceSources.includes(s))) {
                setExposedGuidanceSources((current) => [
                  ...new Set([...current, ...displayedPostSubmitSources]),
                ]);
              }
              const activeExposedMatcher =
                mergedExposedSources.length > allExposedGuidanceSources.length
                  ? buildExposedGuidanceMatcher(mergedExposedSources, unassistedBaselineTexts)
                  : exposedGuidanceMatcher;
              const matchedAssisted =
                matchesAssistedFingerprint(nextTranscript, assistedFingerprints) ||
                matchesExposedGuidance(nextTranscript, activeExposedMatcher);
              if (matchedAssisted) {
                setAttemptAssistedLatched(true);
              }
              setEditedAnswer((current) => ({
                ...(current ?? answer),
                transcript: nextTranscript,
                assisted: (current ?? answer).assisted || matchedAssisted,
              }));
              setLocalEvaluation(null);
            }}
            placeholder={`先口头计时说 ${seed.timeWindowSeconds.min}–${seed.timeWindowSeconds.max} 秒，再粘贴转写稿或记录你的关键表达...`}
            className="block w-full rounded-ctl border border-line-strong bg-surface px-3.5 py-2.5 font-reading text-read leading-6 text-text placeholder:text-text-3 focus:border-text focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-meta text-text-2">
              <span>作答时长</span>
              <input
                type="number"
                aria-label="口语作答时长秒数"
                min={1}
                max={180}
                value={durationInput}
                onChange={(event) => {
                  const nextDuration = event.target.value;
                  if (displayedPostSubmitSources.length > 0) {
                    setExposedGuidanceSources((current) => [
                      ...new Set([...current, ...displayedPostSubmitSources]),
                    ]);
                  }
                  setEditedAnswer((current) => ({
                    ...(current ?? answer),
                    durationInput: nextDuration,
                  }));
                  setLocalEvaluation(null);
                }}
                className="w-20 rounded-ctl border border-line-strong bg-surface px-2.5 py-1 text-center tabular-nums text-text"
              />
              <span>秒</span>
            </label>

            <label
              className={`inline-flex items-center gap-2 text-meta text-text-2 ${
                isStickyAssisted ? "cursor-not-allowed" : "cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                checked={assisted}
                disabled={isStickyAssisted}
                onChange={(event) => {
                  if (isStickyAssisted) return;
                  const nextAssisted = event.target.checked;
                  setEditedAnswer((current) => ({
                    ...(current ?? answer),
                    assisted: nextAssisted,
                  }));
                  setLocalEvaluation(null);
                }}
                className="size-4 accent-ink disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span>
                {isStickyAssisted
                  ? "本次作答已含提示/稿件辅助，已锁定为练习诊断（点击「清空重做」可开始新的独立作答）"
                  : "对照了写作稿件（不计入正式掌握度）"}
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-speaking-evaluate
              onClick={handleEvaluate}
              className="rounded-pill bg-ink px-4 py-1.5 text-meta font-medium text-on-ink hover:bg-ink/90"
            >
              生成口语反馈
            </button>
            {!isDemoPreview && (
              <button
                type="button"
                data-reset-attempt
                onClick={handleResetForFreshAttempt}
                className="rounded-pill px-3 py-1.5 text-meta text-text-2 hover:bg-surface-2 hover:text-text"
              >
                清空重做（开始独立作答）
              </button>
            )}
          </div>
        </div>

        {!isDemoPreview && !hasSubstantiveSubmission && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-cap text-text-2">
                需要口语破题提示或示范转写？展开后本次尝试将不可逆地标记为含辅助练习。
              </span>
              <button
                type="button"
                data-reveal-scaffold
                disabled={hintsRevealed}
                onClick={handleRevealScaffold}
                className="rounded-pill border border-line-strong bg-surface px-3 py-1 text-cap font-medium text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {hintsRevealed
                  ? "已展开提示 / 示范转写（本次已标记为含辅助）"
                  : "查看提示 / 示范转写（将标记本次作答为含辅助）"}
              </button>
            </div>

            {hintsRevealed && (
              <div
                data-speaking-scaffold="true"
                className="space-y-2 rounded-ctl border border-line bg-surface p-3 text-meta"
              >
                <p className="text-cap font-medium text-warn">
                  提示与示范脚手架已展开 · 本次口语作答已锁定为含辅助练习，不计入正式掌握度
                </p>
                <ul className="space-y-1 text-text-2">
                  {seed.argumentBridgeCues.map((cue, idx) => (
                    <li key={idx} className="flex gap-2">
                      <span className="font-mono text-cap text-text-3">{idx + 1}.</span>
                      <span>{cue}</span>
                    </li>
                  ))}
                </ul>
                {scaffoldSampleTranscript && (
                  <div className="border-t border-line pt-2">
                    <p className="mb-1 text-cap font-medium text-text-3">示范转写参考</p>
                    <p
                      data-speaking-sample-transcript
                      className="font-reading text-meta leading-6 text-text"
                    >
                      {scaffoldSampleTranscript}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {receipt && paceMeta && (
        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-ui-lg font-semibold text-text">转写迁移检核反馈</h3>
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-speaking-pace={receipt.paceStatus}
                className={`rounded-pill border px-2.5 py-0.5 text-cap font-medium ${paceMeta.badgeClass}`}
              >
                {paceMeta.label}
                {receipt.durationSeconds !== null ? ` · ${receipt.durationSeconds} 秒` : ""}
              </span>
              <span className="rounded-pill border border-line bg-surface-2 px-2.5 py-0.5 text-cap tabular-nums text-text-2">
                {receipt.wordCount} 词
              </span>
            </div>
          </div>

          <p className="text-meta text-text-2">
            {isDemoPreview
              ? "当前为示例预览模式，仅展示口语迁移检核样例，不代表你已完成独立作答或获得正式掌握度。"
              : receipt.epistemicReason}
          </p>

          {receipt.memorizedTemplateHits.length > 0 && (
            <div
              role="alert"
              className="rounded-ctl border border-danger/30 bg-danger-soft p-3 text-meta text-danger"
            >
              检测到口语模板套话：
              {receipt.memorizedTemplateHits.map((h) => h.phrase).join("、")}
              。建议改用自然口语过渡，直接给出核心判断与具体例子。
            </div>
          )}

          {/* Honest Transcript Signals (No fake official Band / No Writing TR) */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {SPEAKING_SIGNAL_ORDER.map((signalKey) => {
              const signal = receipt.transcriptSignals[signalKey];
              const ratingMeta = SPEAKING_SIGNAL_RATING_META[signal.rating];
              return (
                <div
                  key={signal.key}
                  data-speaking-signal={signal.key}
                  className="rounded-tile border border-line bg-bg p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ui font-semibold text-text">
                      {signal.label}
                    </span>
                    <span
                      className={`rounded-pill border px-2.5 py-0.5 text-cap font-medium ${ratingMeta.badgeClass}`}
                    >
                      {ratingMeta.label}
                    </span>
                  </div>
                  <p className="mt-1.5 text-meta text-text-2">{signal.note}</p>
                </div>
              );
            })}
          </div>

          {receipt.evidenceQuotes.length > 0 && (
            <div className="space-y-2">
              <p className="text-cap font-medium text-text-3">转写原句引证与微调建议</p>
              {receipt.evidenceQuotes.map((item) => (
                <div
                  key={item.id}
                  data-speaking-quote={item.signal}
                  className="rounded-ctl border border-line bg-bg p-3 text-meta"
                >
                  {item.matchedExpression && (
                    <p className="mb-1 text-cap font-medium text-accent">
                      命中表达：{item.matchedExpression}
                    </p>
                  )}
                  <blockquote className="border-l-2 border-line-strong pl-2.5 font-reading text-ui text-text">
                    &ldquo;{item.quote}&rdquo;
                  </blockquote>
                  <p className="mt-1.5 text-text-2">{item.diagnosis}</p>
                  <p className="mt-1 text-text-2">
                    <strong className="font-medium text-accent">更自然说法：</strong>
                    <span className="font-reading text-text">{item.upgradeRewrite}</span>
                  </p>
                </div>
              ))}
            </div>
          )}

          {hasSubstantiveSubmission && (
            <div className="rounded-ctl border border-line bg-surface-2/60 p-3 text-cap text-text-2">
              <p className="font-medium text-text">口语中建议避开的生硬书面衔接：</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {seed.avoidWrittenClunkyPhrases.map((phrase) => (
                  <li key={phrase}>{phrase}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
