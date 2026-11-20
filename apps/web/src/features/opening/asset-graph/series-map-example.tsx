"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, X } from "lucide-react";
import type { AssetGraphNodeId } from "@aistudy/contracts";
import { tone, ui } from "../design/ui";
import { FreeMapCanvas } from "./free-map-canvas";
import {
  SERIES_CHECK_KEY,
  SERIES_COMPARISON,
  SERIES_MARK,
  SERIES_QUESTIONS,
  readSeriesCheck,
  seriesExampleDetail,
  seriesExampleGraph,
  seriesOutcome,
  type SeriesCheck,
} from "./series-map-example-model";

export const SERIES_SANDBOX_BADGE = "示例沙盒 · 不计入个人课程记录";

export function SeriesMapExample({
  returnHref = "/opening/map",
  onExit,
}: {
  returnHref?: string;
  onExit?: () => void;
}) {
  const [check, setCheck] = useState<SeriesCheck>(() => readSeriesCheck(null));
  const currentCheck = useRef(check);
  const [loaded, setLoaded] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [mode, setMode] = useState<"exam" | "study">("exam");
  const [selectedId, setSelectedId] = useState<AssetGraphNodeId>(SERIES_COMPARISON);
  const [exerciseOpen, setExerciseOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    try {
      currentCheck.current = readSeriesCheck(
        JSON.parse(localStorage.getItem(SERIES_CHECK_KEY) ?? "null"),
      );
      setCheck(currentCheck.current);
    } catch {
      setStorageMessage("未能恢复本机示例记录，可在当前会话继续体验。");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (exerciseOpen) {
      if (!element.open) {
        if (typeof element.showModal === "function") element.showModal();
        else element.setAttribute("open", "");
      }
    } else if (element.open) {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
      opener.current?.focus({ preventScroll: true });
    }
  }, [exerciseOpen]);

  useEffect(() => {
    if (exerciseOpen) title.current?.focus({ preventScroll: true });
  }, [exerciseOpen, check.answers.length, check.hints]);

  function update(next: SeriesCheck) {
    currentCheck.current = next;
    setCheck(next);
    try {
      localStorage.setItem(SERIES_CHECK_KEY, JSON.stringify(next));
    } catch {
      setStorageMessage("浏览器未允许保存，示例记录仅保留到本次页面关闭。");
    }
  }

  function openExercise() {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExerciseOpen(true);
  }

  const graph = useMemo(() => seriesExampleGraph(check), [check]);
  const selected = graph.nodes.find(node => node.id === selectedId);
  const outcome = seriesOutcome(check);
  const questionIndex = check.answers.length;
  const question = SERIES_QUESTIONS[questionIndex];
  const exerciseLabel = outcome ? "回看两步作答" : questionIndex ? "继续这次辨析" : "做两步辨析";

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg text-text"
      aria-label="数项级数示例沙盒"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="mr-auto flex flex-wrap items-center gap-2">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <BookOpen size={20} aria-hidden="true" />
            <span>数项级数示例</span>
          </h1>
          <span className={`${ui.badge} ${tone.warning}`}>{SERIES_SANDBOX_BADGE}</span>
        </div>
        <div role="group" aria-label="示例查看视角" className={ui.segment}>
          <button
            type="button"
            className={ui.segmentItem}
            aria-pressed={mode === "exam"}
            onClick={() => setMode("exam")}
          >
            考前自查
          </button>
          <button
            type="button"
            className={ui.segmentItem}
            aria-pressed={mode === "study"}
            onClick={() => setMode("study")}
          >
            结构整理
          </button>
        </div>
        {onExit ? (
          <button type="button" className={ui.secondary} onClick={onExit}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回真实地图
          </button>
        ) : (
          <a className={ui.secondary} href={returnHref}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回真实地图
          </a>
        )}
      </header>
      <div data-scroll-root className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        <p className="text-sm leading-6 text-text-2">
          教学演示沙盒。图中的历史记录为示例；你的两步作答仅保留在本地示例中，不会影响个人课程记录、学习证据或复测安排。
        </p>
        {storageMessage ? (
          <p role="status" className="text-sm text-text-2">
            {storageMessage}
          </p>
        ) : null}
        {loaded ? (
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0">
              <FreeMapCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                selectedId={selectedId}
                mode={mode}
                onSelect={setSelectedId}
                layoutKey="series-example-v1"
                persistKey="series-example-layout-v1"
              />
            </div>
            <aside
              className="space-y-4 rounded-tile border border-line bg-surface p-4"
              aria-label="示例节点详情"
            >
              <h2 className="text-lg font-semibold">{selected?.label ?? "选择示例节点"}</h2>
              <p className="text-sm leading-6 text-text-2">
                {seriesExampleDetail(selectedId, check)}
              </p>
              {selectedId === SERIES_MARK ? (
                <button type="button" className={ui.primary} onClick={openExercise}>
                  查看这条标记的两步原答
                </button>
              ) : null}
              <div className="space-y-3 border-t border-line pt-4">
                <h3 className="font-medium">比较判别法 · 考点自查</h3>
                {outcome ? (
                  <p className="text-sm text-text-2">{outcome.summary}</p>
                ) : (
                  <p className="text-sm text-text-2">先辨清不等式方向，再选择可用的上界。</p>
                )}
                <button type="button" className={ui.primary} onClick={openExercise}>
                  {exerciseLabel}
                </button>
                <label className="flex items-start gap-2 text-sm leading-6 text-text-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-accent"
                    checked={check.reviewed}
                    onChange={event => update({ ...check, reviewed: event.target.checked })}
                  />
                  本轮我已在纸上复习
                </label>
                <p className="text-xs leading-5 text-text-3">
                  纸上复习是个人接触记录，与两步作答结果分开，不据此判断掌握。
                </p>
              </div>
            </aside>
          </div>
        ) : (
          <p role="status" className="text-sm text-text-2">
            正在恢复本机示例…
          </p>
        )}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="series-question-title"
        onCancel={event => {
          event.preventDefault();
          setExerciseOpen(false);
        }}
        className="m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-tile border border-line bg-surface p-5 text-text shadow-card backdrop:bg-bg/70"
      >
        <div className="flex items-center justify-between gap-3 text-sm text-text-2">
          <span>
            {question ? `比较判别法 · ${questionIndex + 1} / 2` : "比较判别法 · 本次作答"}
          </span>
          <button type="button" className={ui.secondary} onClick={() => setExerciseOpen(false)}>
            回到导图
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {question ? (
          <div className="mt-5 space-y-4">
            <h2
              id="series-question-title"
              ref={title}
              tabIndex={-1}
              className="text-xl font-semibold outline-none"
            >
              {question.title}
            </h2>
            <p className="text-sm leading-7">{question.prompt}</p>
            <div className="grid gap-2">
              {question.choices.map((choice, index) => (
                <button
                  type="button"
                  key={choice}
                  className="rounded-ctl border border-line px-3 py-3 text-left text-sm hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() => {
                    if (currentCheck.current.answers.length !== questionIndex) return;
                    update({
                      ...currentCheck.current,
                      answers: [...currentCheck.current.answers, index],
                    });
                  }}
                >
                  {choice}
                </button>
              ))}
            </div>
            {check.hints[questionIndex] ? (
              <p role="status" className="text-sm leading-6 text-text-2">
                {question.hint}
              </p>
            ) : (
              <button
                type="button"
                className="text-sm text-accent underline underline-offset-4"
                onClick={() =>
                  update({
                    ...check,
                    hints: check.hints.map((hint, index) => hint || index === questionIndex),
                  })
                }
              >
                看一个提示
              </button>
            )}
          </div>
        ) : outcome ? (
          <div className="mt-5 space-y-4">
            <h2
              id="series-question-title"
              ref={title}
              tabIndex={-1}
              className="text-xl font-semibold outline-none"
            >
              {outcome.label}
            </h2>
            <p className="text-sm leading-6">{outcome.summary}</p>
            {SERIES_QUESTIONS.map((q, index) => (
              <details key={q.title} className="border-b border-line pb-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {q.title} · {check.answers[index] === q.correct ? "答对" : "答错"} ·{" "}
                  {check.hints[index] ? "看过提示" : "未点提示"}
                </summary>
                <p className="mt-2 text-sm leading-6 text-text-2">
                  你选了「{q.choices[check.answers[index]!]}」。{q.why}
                </p>
              </details>
            ))}
            <button
              type="button"
              className={ui.primary}
              disabled={check.attached}
              onClick={() => update({ ...check, attached: true })}
            >
              {check.attached ? "已挂到比较判别法旁" : "把这条复习标记挂到图上"}
            </button>
            <p className="text-xs leading-5 text-text-3">
              依据仅为本机这两道示例题。可以不挂标记，稍后仍可回看原答。
            </p>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
