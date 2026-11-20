// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const { evaluateSpeakingRetelling } = await import("./domain-bridge");
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
