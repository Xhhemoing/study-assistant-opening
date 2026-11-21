"use client";

import { useState } from "react";
import {
  evaluateSpeakingRetelling,
  getSpeakingEvaluationContext,
  getSpeakingTargets,
  maskIeltsMarkup,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPart3Seed,
} from "./domain-bridge";
import { IELTS_WRITING_SPEAKING_FIXTURE } from "./ielts-fixtures";
import {
  EPISTEMIC_BADGE_META,
  SPEAKING_PACE_META,
  SPEAKING_SIGNAL_ORDER,
  SPEAKING_SIGNAL_RATING_META,
} from "./workbench-model";

export type IeltsSpeakingTransferCardProps = {
  readonly seed?: IeltsSpeakingPart3Seed;
  readonly initialTranscript?: string;
  readonly initialDurationSeconds?: number;
  readonly initialReceipt?: IeltsSpeakingFeedbackReceipt;
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

function normalizeTranscriptKey(transcript: string): string {
  const masked = maskIeltsMarkup(transcript)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}+/gu, "");
  const tokens = masked
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => /[a-z]/u.test(token));
  if (tokens && tokens.length > 0) {
    return tokens.join(" ");
  }
  return (
    masked.replace(/\s+/gu, "") ||
    transcript.normalize("NFKC").toLowerCase().replace(/[\s\p{Cf}]+/gu, "")
  );
}

export function IeltsSpeakingTransferCard({
  seed: providedSeed,
  initialTranscript,
  initialDurationSeconds,
  initialReceipt,
  onEvaluated,
}: IeltsSpeakingTransferCardProps) {
  const demo = IELTS_WRITING_SPEAKING_FIXTURE;
  const seed = providedSeed ?? demo.speakingSeed;
  const useDemo = providedSeed === undefined && initialTranscript === undefined &&
    initialDurationSeconds === undefined && initialReceipt === undefined;
  const startingTranscript = useDemo ? demo.initialSpeakingTranscript : initialTranscript ?? "";
  const candidateReceipt = useDemo ? demo.initialSpeakingReceipt : initialReceipt;
  const attemptKey = JSON.stringify([
    seed.seedId, seed.cartridgeId, seed.sourcePromptId, seed.sourceDraftId,
  ]);
  return (
    <SpeakingAttempt
      key={attemptKey}
      seed={seed}
      startingTranscript={startingTranscript}
      seedReceipt={candidateReceipt?.seedId === seed.seedId ? candidateReceipt : null}
      external={{
        transcript: initialTranscript,
        durationSeconds: initialDurationSeconds,
        receiptSnapshot: candidateReceipt && snapshotReceipt(candidateReceipt),
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

function SpeakingAttempt({
  seed,
  startingTranscript,
  seedReceipt,
  external,
  onEvaluated,
}: {
  readonly seed: IeltsSpeakingPart3Seed;
  readonly startingTranscript: string;
  readonly seedReceipt: IeltsSpeakingFeedbackReceipt | null;
  readonly external: ExternalSpeakingInput;
  readonly onEvaluated: IeltsSpeakingTransferCardProps["onEvaluated"];
}) {
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
  const seedReceiptAssistedKey = seedReceipt?.assisted
    ? normalizeTranscriptKey(seedReceipt.sourceTranscript)
    : "";
  const [assistedTranscripts, setAssistedTranscripts] = useState<readonly string[]>(() =>
    seedReceiptAssistedKey ? [seedReceiptAssistedKey] : [],
  );
  if (seedReceiptAssistedKey && !assistedTranscripts.includes(seedReceiptAssistedKey)) {
    setAssistedTranscripts([...assistedTranscripts, seedReceiptAssistedKey]);
    if (
      editedAnswer &&
      !editedAnswer.assisted &&
      normalizeTranscriptKey(editedAnswer.transcript) === seedReceiptAssistedKey
    ) {
      setEditedAnswer({ ...editedAnswer, assisted: true });
    }
  }
  const matchingReceipt = seedReceipt?.sourceTranscript === startingTranscript &&
    (external.durationSeconds === undefined || external.durationSeconds === seedReceipt.durationSeconds)
    ? seedReceipt : null;
  const startingTranscriptKey = normalizeTranscriptKey(startingTranscript);
  const isStartingStickyAssisted = startingTranscriptKey !== "" && (
    seedReceiptAssistedKey === startingTranscriptKey ||
    assistedTranscripts.includes(startingTranscriptKey)
  );
  const answer = editedAnswer ?? {
    transcript: startingTranscript,
    durationInput: String(external.durationSeconds ?? matchingReceipt?.durationSeconds ?? ""),
    assisted: (matchingReceipt?.assisted ?? false) || isStartingStickyAssisted,
  };
  const { transcript, durationInput } = answer;
  const parsedDuration = durationInput.trim() === "" ? Number.NaN : Number(durationInput);
  const receiptDuration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;
  const transcriptKey = normalizeTranscriptKey(transcript);
  const isStickyAssisted = transcriptKey !== "" && (
    seedReceiptAssistedKey === transcriptKey ||
    assistedTranscripts.includes(transcriptKey)
  );
  const assisted = answer.assisted || isStickyAssisted;
  const targets = [...getSpeakingTargets(seed.targetSpokenCollocations).values()];
  const context = getSpeakingEvaluationContext(seed);
  const authority = JSON.stringify([targets, context]);
  let evaluatedReceipt = matchingReceipt;
  if (localEvaluation) {
    const baseline = localEvaluation.external;
    const receiptChanged = baseline.receiptSnapshot !== external.receiptSnapshot;
    const hostOwnsAnswer = external.receiptSnapshot === localEvaluation.receiptSnapshot &&
      external.transcript === localEvaluation.receipt.sourceTranscript &&
      (external.durationSeconds ?? null) === localEvaluation.receipt.durationSeconds;
    if (hostOwnsAnswer) {
      setEditedAnswer(null);
      setLocalEvaluation(null);
    } else if (localEvaluation.authority !== authority ||
      baseline.transcript !== external.transcript ||
      !Object.is(baseline.durationSeconds, external.durationSeconds) ||
      (receiptChanged && localEvaluation.receiptSnapshot !== external.receiptSnapshot)) {
      setLocalEvaluation(null);
    } else {
      evaluatedReceipt = localEvaluation.receipt;
      // Acknowledging the emitted receipt makes a subsequent removal a new change.
      if (receiptChanged) setLocalEvaluation({ ...localEvaluation, external });
    }
  }
  const evaluatedTargets = evaluatedReceipt
    ? [...evaluatedReceipt.transferredCollocations, ...evaluatedReceipt.pendingCollocations]
    : [];
  const evaluatedContext = evaluatedReceipt?.evaluationContext;
  const receipt = evaluatedReceipt?.seedId === seed.seedId &&
    evaluatedReceipt.sourceTranscript === transcript &&
    evaluatedReceipt.durationSeconds === receiptDuration &&
    evaluatedReceipt.assisted === assisted &&
    evaluatedContext?.timeWindowSeconds.min === context.timeWindowSeconds.min &&
    evaluatedContext.timeWindowSeconds.max === context.timeWindowSeconds.max &&
    evaluatedContext.writingReceiptEligible === context.writingReceiptEligible &&
    evaluatedTargets.length === targets.length && targets.every((target) => evaluatedTargets.includes(target)) &&
    (evaluatedReceipt.epistemicStatus !== "rubric_verified_evidence" ||
      (!evaluatedReceipt.assisted && evaluatedReceipt.masteryQualified &&
        evaluatedReceipt.countsTowardMastery && context.writingReceiptEligible))
    ? evaluatedReceipt
    : null;
  const epistemicMeta = receipt ? EPISTEMIC_BADGE_META[receipt.epistemicStatus] : null;
  const paceMeta = receipt ? SPEAKING_PACE_META[receipt.paceStatus] : null;

  function handleEvaluate() {
    const nextReceipt = evaluateSpeakingRetelling({
      seed,
      transcript,
      durationSeconds: parsedDuration,
      assisted,
    });
    if (nextReceipt.assisted) {
      setEditedAnswer((current) =>
        current && !current.assisted ? { ...current, assisted: true } : current,
      );
      if (transcriptKey) {
        setAssistedTranscripts((current) =>
          current.includes(transcriptKey) ? current : [...current, transcriptKey],
        );
      }
    }
    setLocalEvaluation({ authority, external, receiptSnapshot: snapshotReceipt(nextReceipt), receipt: nextReceipt });
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
          {receipt && epistemicMeta && (
            <span
              data-speaking-epistemic={receipt.epistemicStatus}
              className={`inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-meta font-medium ${epistemicMeta.badgeClass}`}
            >
              <span aria-hidden="true" className={`size-2 rounded-pill ${epistemicMeta.dotClass}`} />
              {epistemicMeta.speakingLabel}
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

        <ul className="mt-2 space-y-1 border-t border-line pt-2.5 text-meta text-text-2">
          {seed.argumentBridgeCues.map((cue, idx) => (
            <li key={idx} className="flex gap-2">
              <span className="font-mono text-cap text-text-3">{idx + 1}.</span>
              <span>{cue}</span>
            </li>
          ))}
        </ul>
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
              const transcript = event.target.value;
              setEditedAnswer((current) => ({ ...(current ?? answer), transcript }));
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
                  const durationInput = event.target.value;
                  setEditedAnswer((current) => ({ ...(current ?? answer), durationInput }));
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
                  setEditedAnswer((current) => ({ ...(current ?? answer), assisted: nextAssisted }));
                  setLocalEvaluation(null);
                }}
                className="size-4 accent-ink disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span>
                {isStickyAssisted
                  ? "当前转写已含稿件辅助，不计入正式掌握度（修改转写内容后可取消勾选）"
                  : "对照了写作稿件（不计入正式掌握度）"}
              </span>
            </label>
          </div>

          <button
            type="button"
            onClick={handleEvaluate}
            className="rounded-pill bg-ink px-4 py-1.5 text-meta font-medium text-on-ink hover:bg-ink/90"
          >
            生成口语反馈
          </button>
        </div>
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

          <p className="text-meta text-text-2">{receipt.epistemicReason}</p>

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

          <div className="rounded-ctl border border-line bg-surface-2/60 p-3 text-cap text-text-2">
            <p className="font-medium text-text">口语中建议避开的生硬书面衔接：</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {seed.avoidWrittenClunkyPhrases.map((phrase) => (
                <li key={phrase}>{phrase}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
