// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRevisedDraftDeterministically, evaluateSpeakingRetelling } from "./domain-bridge";
import {
  IELTS_WRITING_SPEAKING_FIXTURE,
  IeltsDraftCritiqueWorkbench,
  IeltsSpeakingTransferCard,
  formatBandScore,
  formatTimeBox,
  segmentParagraphWithSpans,
} from "./index";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function setNativeInputValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function writingButton(label: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

describe("workbench-model helpers", () => {
  it("formats band scores and time-box labels cleanly", () => {
    expect(formatBandScore(7)).toBe("7.0");
    expect(formatBandScore(6.5)).toBe("6.5");
    expect(formatTimeBox(2040, 2400)).toBe("34 / 40 分钟");
  });

  it("segments a paragraph into plain and highlighted span slices without Unicode offset drift", () => {
    const paragraph =
      "İstanbul planners invested in urban rail to ALLEVIATE CHRONIC CONGESTION across dense districts.";
    const spans = [
      {
        id: "istanbul-span",
        paragraphIndex: 0,
        excerpt: "alleviate chronic congestion",
        criterion: "LR" as const,
        diagnosis: "精准学术搭配。",
        upgradeRewrite: "alleviate chronic urban congestion",
      },
    ];

    const segments = segmentParagraphWithSpans(paragraph, spans, "ALL");
    expect(segments.map((s) => s.text).join("")).toBe(paragraph);
    const highlighted = segments.find((s) => s.kind === "span");
    expect(highlighted?.text).toBe("ALLEVIATE CHRONIC CONGESTION");

    const filteredOut = segmentParagraphWithSpans(paragraph, spans, "TR");
    expect(filteredOut).toEqual([{ kind: "text", text: paragraph }]);
  });
});

describe("IeltsDraftCritiqueWorkbench", () => {
  it("reuses the current Writing receipt until the revision changes", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated })));
    await act(async () => writingButton("打开改写编辑区").click());
    await act(async () => writingButton("重新分析改写").click());
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).not.toHaveBeenCalled();
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const editedText = `${textarea.value} Rail operators can then use the savings to extend late-night services.`;
    await act(async () => setNativeInputValue(textarea, editedText));
    await act(async () => writingButton("重新分析改写").click());
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      revisedDraft: expect.objectContaining({
        draftId: `${fixture.draft2.draftId}-rev-1`,
        paragraphs: editedText.split("\n\n"),
      }),
      receipt: expect.objectContaining({ receiptId: "receipt-live-1", countsTowardMastery: true }),
    }));
  });

  it("resets a mounted Writing workbench to the next assisted attempt", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const paragraph = "My local council should invest in electric buses.";
    const draft2 = { ...fixture.draft2, draftId: "second-writing-attempt", paragraphs: [paragraph], assisted: true };
    const next = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: draft2,
      targets: fixture.targets,
      receiptId: "second-writing-receipt",
    });
    if (!next.ok) throw new Error("Expected a practice receipt for an assisted Writing attempt");
    const nextFixture = { ...fixture, draft2, draft2Receipt: next.receipt, transferReport: next.transferReport };

    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, { fixture })));
    await act(async () => writingButton("打开改写编辑区").click());
    await act(async () => setNativeInputValue(host.querySelector<HTMLTextAreaElement>("textarea")!, "..."));
    await act(async () => writingButton("重新分析改写").click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click());
    await act(async () => writingButton("对照视图").click());

    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, { fixture: nextFixture })));
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("二稿");
    expect(host.querySelector("[data-word-count]")?.textContent).toMatch(/^8 词/u);
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain(paragraph);
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
    expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 0 / 4");
    expect(writingButton("全部维度").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("textarea")).toBeNull();
    await act(async () => writingButton("打开改写编辑区").click());
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(paragraph);
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(host.querySelector("textarea")?.hasAttribute("aria-invalid")).toBe(false);
  });

  it("syncs revoked Writing evidence under the same receipt ID and reanalyzes against the new targets", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    const targets: typeof fixture.targets = [];
    const downgraded = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: fixture.draft2,
      targets,
      receiptId: fixture.draft2Receipt.receiptId,
    });
    if (!downgraded.ok) throw new Error("Expected a receipt for the existing Writing draft");
    const render = (nextFixture: typeof fixture) => act(async () => root.render(createElement(
      IeltsDraftCritiqueWorkbench, { fixture: nextFixture, onRevisionEvaluated },
    )));
    const nextFixture = { ...fixture, targets, draft2Receipt: downgraded.receipt, transferReport: downgraded.transferReport };

    await render(fixture);
    await act(async () => writingButton("打开改写编辑区").click());
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();
    expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 4 / 4");

    await render({ ...fixture, targets });
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();
    expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 0 / 0");

    await render(nextFixture);
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
    expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 0 / 0");
    expect(onRevisionEvaluated).not.toHaveBeenCalled();

    await act(async () => writingButton("重新分析改写").click());
    await render(structuredClone(nextFixture));
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      receipt: expect.objectContaining({ epistemicStatus: "practice_feedback", countsTowardMastery: false }),
      transferReport: expect.objectContaining({ summary: expect.objectContaining({ transferredCount: 0, totalTargets: 0 }) }),
    }));
  });

  it("asks for English text when a punctuation-only revision is submitted", async () => {
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated })));
    const findButton = (label: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;
    await act(async () => findButton("打开改写编辑区").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    await act(async () => setNativeInputValue(textarea, "..."));
    await act(async () => findButton("重新分析改写").click());
    expect(onRevisionEvaluated).not.toHaveBeenCalled();
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent).toContain("英文单词");

    await act(async () => setNativeInputValue(textarea, "The council plans to extend rail service."));
    await act(async () => findButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledOnce();
    expect(textarea.getAttribute("aria-invalid")).not.toBe("true");
  });
  it("renders Draft 2 verified evidence, switches to Draft 1 practice feedback and comparison view", async () => {
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench)));

    expect(
      host.querySelector("[data-epistemic-badge]")?.getAttribute("data-epistemic-badge"),
    ).toBe("rubric_verified_evidence");
    expect(host.querySelector("[data-epistemic-badge]")?.textContent).toContain(
      "量规复核证据 · 跨稿迁移已确认",
    );
    expect(host.querySelector("[data-overall-band]")?.textContent).toContain("Band 7.5");
    expect(host.querySelectorAll("[data-criterion-card]")).toHaveLength(4);
    expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain(
      "已迁移 4 / 4",
    );
    expect(host.querySelectorAll("[data-span-id]").length).toBeGreaterThan(0);

    const draft1Tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === "一稿",
    )!;
    await act(async () => draft1Tab.click());

    expect(
      host.querySelector("[data-epistemic-badge]")?.getAttribute("data-epistemic-badge"),
    ).toBe("practice_feedback");
    expect(host.querySelector("[data-epistemic-badge]")?.textContent).toContain(
      "练习诊断反馈 · 不计入正式掌握度",
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "with the rapid development of",
    );

    const compareTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === "对照视图",
    )!;
    await act(async () => compareTab.click());
    expect(host.textContent).toContain("逐段改写对照");
    expect(host.textContent).toContain("一稿原文");
    expect(host.textContent).toContain("二稿改写");
  });

  it("keeps all 3 WAI-ARIA tabpanels mounted for valid aria-controls with inactive ones hidden, and supports ArrowLeft/ArrowRight/Home/End keyboard navigation", async () => {
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench)));

    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(3);
    const [tabDraft1, tabDraft2, tabCompare] = tabs as [
      HTMLButtonElement,
      HTMLButtonElement,
      HTMLButtonElement,
    ];

    // All 3 tabpanels must exist simultaneously in DOM so every tab's aria-controls resolves.
    const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels).toHaveLength(3);
    const panelFor = (tab: HTMLButtonElement) => {
      const controlsId = tab.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();
      const panel = host.querySelector<HTMLElement>(`[id="${controlsId!}"]`);
      expect(panel).not.toBeNull();
      expect(panel!.getAttribute("aria-labelledby")).toBe(tab.id);
      return panel!;
    };

    const panelDraft1 = panelFor(tabDraft1);
    const panelDraft2 = panelFor(tabDraft2);
    const panelCompare = panelFor(tabCompare);

    // Initial active tab is Draft 2; Draft 1 and Compare panels are mounted and hidden.
    expect(tabDraft2.getAttribute("aria-selected")).toBe("true");
    expect(tabDraft2.tabIndex).toBe(0);
    expect(tabDraft1.tabIndex).toBe(-1);
    expect(panelDraft2.hidden).toBe(false);
    expect(panelDraft1.hidden).toBe(true);
    expect(panelCompare.hidden).toBe(true);

    // IME composing events must not hijack tab switching.
    tabDraft2.focus();
    await act(async () => {
      tabDraft2.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    expect(tabDraft2.getAttribute("aria-selected")).toBe("true");
    expect(panelDraft2.hidden).toBe(false);

    // ArrowRight moves to Compare tab, shifts focus, and toggles hidden cleanly.
    await act(async () => {
      tabDraft2.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tabCompare.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabCompare);
    expect(panelCompare.hidden).toBe(false);
    expect(panelDraft1.hidden).toBe(true);
    expect(panelDraft2.hidden).toBe(true);

    // ArrowRight from last tab wraps to first tab (Draft 1).
    await act(async () => {
      tabCompare.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tabDraft1.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabDraft1);
    expect(panelDraft1.hidden).toBe(false);
    expect(panelDraft2.hidden).toBe(true);
    expect(panelCompare.hidden).toBe(true);

    // ArrowLeft from first tab wraps back to Compare tab.
    await act(async () => {
      tabDraft1.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tabCompare.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabCompare);
    expect(panelCompare.hidden).toBe(false);

    // Home jumps to first tab, End jumps to last tab.
    await act(async () => {
      tabCompare.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tabDraft1.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabDraft1);
    expect(panelDraft1.hidden).toBe(false);

    await act(async () => {
      tabDraft1.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tabCompare.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabCompare);
    expect(panelCompare.hidden).toBe(false);
  });

  it("downgrades epistemic status to practice_feedback when inline revision introduces memorized clichés", async () => {
    const onRevisionEvaluated = vi.fn();
    await act(async () =>
      root.render(
        createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated }),
      ),
    );

    const openComposerBtn = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "打开改写编辑区")!;
    await act(async () => openComposerBtn.click());

    const textarea = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="二稿改写编辑区"]',
    )!;
    const stuffedEssay = `Every coin has two sides when cities debate transport spending.\n\n${IELTS_WRITING_SPEAKING_FIXTURE.draft2.paragraphs.slice(1).join("\n\n")}`;

    await act(async () => setNativeInputValue(textarea, stuffedEssay));

    const analyzeBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "重新分析改写",
    )!;
    await act(async () => analyzeBtn.click());

    expect(onRevisionEvaluated).toHaveBeenCalledOnce();
    expect(
      host.querySelector("[data-epistemic-badge]")?.getAttribute("data-epistemic-badge"),
    ).toBe("practice_feedback");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "every coin has two sides",
    );
  });
});

describe("IeltsSpeakingTransferCard", () => {
  it.each(["seed", "receipt"] as const)("restores Speaking inputs when the external %s changes", async (change) => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const seed = change === "seed" ? { ...fixture.speakingSeed, seedId: "second-speaking-attempt" } : fixture.speakingSeed;
    const transcript = change === "seed" ? "My local council should invest in electric buses." : fixture.initialSpeakingTranscript;
    const initialReceipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds: 36, assisted: true });
    const onEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, { onEvaluated })));
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed, initialTranscript: transcript, initialReceipt, onEvaluated,
    })));
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(transcript);
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("36");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onEvaluated).toHaveBeenCalledWith(expect.objectContaining({
      seedId: seed.seedId, sourceTranscript: transcript, durationSeconds: 36, assisted: true,
    }));
  });

  it("shows each Speaking target once and guides a learner who submits only punctuation", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed: { ...fixture.speakingSeed, targetSpokenCollocations: ["per-capita emissions", " per-capita  emissions "] },
      initialTranscript: "...",
      initialDurationSeconds: 75,
      onEvaluated,
    })));
    expect(host.textContent).toContain("已迁移 0 / 1");
    expect(host.querySelectorAll("[data-collocation-state]")).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onEvaluated).toHaveBeenCalledWith(expect.objectContaining({ wordCount: 0, countsTowardMastery: false }));
    expect(host.textContent).toContain("英文单词");
    expect(host.querySelectorAll("[data-speaking-quote]")).toHaveLength(0);
  });

  it("presents honest transcript practice feedback without fake official Band or Writing Task Response, and enforces strict pace & transfer gates", async () => {
    const onEvaluated = vi.fn();
    await act(async () =>
      root.render(createElement(IeltsSpeakingTransferCard, { onEvaluated })),
    );

    // Must NOT claim an official Band score or Writing's Task Response dimension
    expect(host.querySelector("[data-speaking-band]")).toBeNull();
    expect(host.textContent).not.toContain("Task Response");
    expect(host.textContent).not.toContain("任务回应");
    expect(
      host.querySelector("[data-speaking-mode]")?.textContent,
    ).toContain("转写练习反馈 / 迁移检核");
    expect(
      host.querySelector("[data-pronunciation-disclaimer]")?.textContent,
    ).toContain("不含真实语音发音");

    // All 4 honest transcript signals rendered
    expect(host.querySelectorAll("[data-speaking-signal]")).toHaveLength(4);
    expect(host.textContent).toContain("流利与衔接线索");
    expect(host.textContent).toContain("词汇迁移");
    expect(host.textContent).toContain("句式多样性");
    expect(host.textContent).toContain("时长达标度");

    expect(
      host
        .querySelector("[data-speaking-epistemic]")
        ?.getAttribute("data-speaking-epistemic"),
    ).toBe("rubric_verified_evidence");
    expect(
      host.querySelector("[data-speaking-pace]")?.getAttribute("data-speaking-pace"),
    ).toBe("on_target");
    expect(
      host.querySelectorAll('[data-collocation-state="transferred"]').length,
    ).toBeGreaterThanOrEqual(4);

    // Short 15-second answer downgrades honestly to practice_feedback
    const textarea = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="口语复述记录输入框"]',
    )!;
    const durationInput = host.querySelector<HTMLInputElement>(
      '[aria-label="口语作答时长秒数"]',
    )!;

    await act(async () => {
      setNativeInputValue(
        textarea,
        "I think trains are better for cities because they alleviate chronic congestion.",
      );
      setNativeInputValue(durationInput, "15");
    });

    const evalBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "生成口语反馈",
    )!;
    await act(async () => evalBtn.click());

    expect(onEvaluated).toHaveBeenCalledOnce();
    expect(
      host
        .querySelector("[data-speaking-epistemic]")
        ?.getAttribute("data-speaking-epistemic"),
    ).toBe("practice_feedback");
    expect(
      host.querySelector("[data-speaking-pace]")?.getAttribute("data-speaking-pace"),
    ).toBe("too_short");
    expect(
      host.querySelectorAll('[data-collocation-state="transferred"]').length,
    ).toBe(1);
    expect(
      host.querySelectorAll('[data-collocation-state="pending"]').length,
    ).toBe(4);
  });
});

it("uses readable foreground and keeps the CC tint on the selected chip", async () => {
  await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench)));
  const chip = [...host.querySelectorAll("button")].find((button) =>
    button.classList.contains("hover:border-obj-2/40"),
  );
  expect(chip).toBeDefined();
  await act(async () => chip!.click());
  expect(chip!.classList).toContain("text-text");
  expect(chip!.classList).not.toContain("text-obj-2");
  expect(chip!.classList).toContain("border-obj-2/45");
  expect(chip!.classList).toContain("bg-obj-2/12");
});

it.each(["custom seed", "custom transcript", "mismatched receipt"])(
  "starts without a demo Speaking receipt for a %s",
  async (variant) => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const props = variant === "custom seed"
      ? { seed: { ...fixture.speakingSeed, seedId: "custom-speaking-seed" } }
      : variant === "custom transcript"
        ? { initialTranscript: "Another transcript with its own independent answer." }
        : { initialTranscript: fixture.initialSpeakingTranscript + " Changed.", initialReceipt: fixture.initialSpeakingReceipt };
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, props)));
    expect(host.querySelector("[data-speaking-epistemic]")).toBeNull();
    expect(host.querySelectorAll('[data-collocation-state="transferred"]')).toHaveLength(0);
    expect(host.querySelectorAll("[data-speaking-quote]")).toHaveLength(0);
  },
);

it("shows an explicitly matched Speaking receipt", async () => {
  const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
  const seed = { ...fixture.speakingSeed, seedId: "custom-speaking-seed" };
  const transcript = fixture.initialSpeakingTranscript;
  const durationSeconds = fixture.initialSpeakingDurationSeconds;
  const initialReceipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds, assisted: false });
  await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
    seed,
    initialTranscript: transcript,
    initialDurationSeconds: durationSeconds,
    initialReceipt,
  })));
  expect(host.querySelector("[data-speaking-epistemic]")?.getAttribute("data-speaking-epistemic"))
    .toBe("rubric_verified_evidence");
});

it("restores downgraded Speaking feedback under the same receipt ID", async () => {
  const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
  const initial = fixture.initialSpeakingReceipt;
  const revoked = {
    ...initial,
    epistemicStatus: "practice_feedback" as const,
    masteryQualified: false,
    countsTowardMastery: false,
    transferredCollocations: [],
    pendingCollocations: initial.transferredCollocations,
    evidenceQuotes: [],
  };
  const render = (initialReceipt: typeof initial) => act(async () => root.render(createElement(
    IeltsSpeakingTransferCard, {
      seed: fixture.speakingSeed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
      initialReceipt,
    },
  )));

  await render(initial);
  expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).not.toBeNull();
  await render(revoked);
  expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();
  expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
  expect(host.textContent).toContain("已迁移 0 / 5");

  await render({ ...initial, masteryQualified: false });
  expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();
});

it("withholds stale Speaking feedback after the targets change on the same seed", async () => {
  const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
  const initialProps = {
    initialTranscript: fixture.initialSpeakingTranscript,
    initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
    initialReceipt: fixture.initialSpeakingReceipt,
  };
  const changedSeed = { ...fixture.speakingSeed, targetSpokenCollocations: ["affordable housing"] };
  const render = (seed: typeof changedSeed, key: string) =>
    act(async () => root.render(createElement(IeltsSpeakingTransferCard, { ...initialProps, seed, key })));
  const verifiedBadge = () => host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]');

  await render(fixture.speakingSeed, "existing");
  expect(verifiedBadge()).not.toBeNull();
  expect(host.textContent).toContain("已迁移 5 / 5");

  for (const key of ["existing", "restored"]) {
    await render(changedSeed, key);
    expect(verifiedBadge()).toBeNull();
    expect(host.textContent).toContain("已迁移 0 / 1");
    expect(host.querySelector('[data-collocation-state="pending"]')?.textContent).toBe("affordable housing");
    expect(host.querySelectorAll("[data-speaking-quote]")).toHaveLength(0);
  }

  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
  expect(host.textContent).toContain("已迁移 0 / 1");
});

it.each(["removed", "invalidated"])("withholds restored Speaking mastery when the Writing receipt is %s", async (change) => {
  const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
  const initialProps = {
    seed: fixture.speakingSeed,
    initialTranscript: fixture.initialSpeakingTranscript,
    initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
    initialReceipt: fixture.initialSpeakingReceipt,
  };
  const invalidSeed = {
    ...initialProps.seed,
    verifiedWritingReceipt: change === "removed" ? undefined : { ...fixture.draft2Receipt, masteryQualified: false },
  };
  const render = async (seed: typeof initialProps.seed, key: string) =>
    act(async () => root.render(createElement(IeltsSpeakingTransferCard, { ...initialProps, seed, key })));
  const badge = () => host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]');
  await render(initialProps.seed, "existing");
  expect(badge()).not.toBeNull();
  await render(invalidSeed, "existing");
  expect(badge()).toBeNull();
  await render(invalidSeed, "restored");
  expect(badge()).toBeNull();
});

it("restores a matching assisted Speaking receipt and preserves assistance on reevaluation", async () => {
  const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
  const seed = { ...fixture.speakingSeed, seedId: "assisted-speaking-seed" };
  const transcript = fixture.initialSpeakingTranscript;
  const durationSeconds = fixture.initialSpeakingDurationSeconds;
  const initialReceipt = evaluateSpeakingRetelling({ seed, transcript, durationSeconds, assisted: true });
  const onEvaluated = vi.fn();
  await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
    seed,
    initialTranscript: transcript,
    initialDurationSeconds: durationSeconds,
    initialReceipt,
    onEvaluated,
  })));
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onEvaluated).toHaveBeenCalledWith(expect.objectContaining({
    assisted: true,
    epistemicStatus: "practice_feedback",
    masteryQualified: false,
  }));
});
