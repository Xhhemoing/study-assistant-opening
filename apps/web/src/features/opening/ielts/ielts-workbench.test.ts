// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSpeakingPart3Seed,
  evaluateRevisedDraftDeterministically,
  evaluateSpeakingRetelling,
} from "./domain-bridge";
import {
  IELTS_WRITING_SPEAKING_FIXTURE,
  IeltsDraftCritiqueWorkbench,
  IeltsSpeakingTransferCard,
  collectAssistedFingerprints,
  formatBandScore,
  formatTimeBox,
  matchesAssistedFingerprint,
  normalizeAssistedTextKey,
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

const GENUINE_ORIGINAL_WRITING_ESSAY = [
  "City councils across fast-growing metropolitan regions must decide whether public capital belongs in rail transit systems or wider road corridors for private vehicles. Despite widespread household attachment to automobiles, directing capital toward modern electric trains offers stronger long-term fiscal viability and cleaner urban neighbourhoods than pouring concrete into extra highway lanes.",
  "Modern underground and suburban rail corridors can transport tens of thousands of office workers and university students hourly without demolishing historic streets or paving over parks. Consequently, encouraging commuters to replace daily solo car trips with punctual train journeys reduces per-capita emissions and helps cities alleviate chronic congestion throughout dense residential zones. Reliable urban rail schedules also support downtown shops and cut repair bills on worn asphalt.",
  "Admittedly, households settled in distant outer towns frequently lack nearby train platforms and rely on personal cars after dusk. While expanding motorways can ease journey delays for a brief season, induced traffic demand soon encourages fresh car trips onto every widened lane, which undermines those temporary speed improvements. Pairing regional rail stations with dependable feeder buses resolves outer-suburban gaps without repeating that cycle.",
  "Ultimately, combining backbone rail transit with accessible feeder buses delivers durable mobility that extra road lanes never sustain. Policymakers should therefore focus public transport spending on modern rail networks rather than endless motorway widening.",
].join("\n\n");

const GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT =
  "To be honest, elected mayors often struggle because commuters notice freshly paved lanes right before polling day, whereas major subway lines require years of digging and upfront funding. " +
  "That said, backing urban trains helps cities alleviate chronic congestion and lower per-capita emissions across crowded residential districts. " +
  "Admittedly, households in outer towns still rely on personal vehicles where stations sit miles away, so local planners should pair core lines with frequent feeder buses. " +
  "Overall, cities can only protect long-term fiscal viability when councils fund dependable rail corridors instead of endless asphalt projects that trigger induced traffic demand.";

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

  it("falls back to grounded grapheme-safe offsets when a span offset slice is stale", () => {
    const paragraph = "Urban rail can alleviate chronic congestion across dense districts.";
    const spans = [{
      id: "stale-offset",
      paragraphIndex: 0,
      excerpt: "alleviate chronic congestion",
      startOffset: 0,
      endOffset: 5,
      criterion: "LR" as const,
      diagnosis: "精准学术搭配。",
      upgradeRewrite: "alleviate chronic urban congestion",
    }];

    const segments = segmentParagraphWithSpans(paragraph, spans, "ALL");
    expect(segments.find((segment) => segment.kind === "span")?.text)
      .toBe("alleviate chronic congestion");
  });

  it("honors the validated offsets of multiple occurrences in prose", () => {
    const paragraph = '<div title="congestion">Rail reduces congestion. Buses also reduce congestion.</div>';
    const span = {
      id: "rail",
      paragraphIndex: 0,
      excerpt: "congestion",
      criterion: "LR" as const,
      diagnosis: "精准搭配。",
      upgradeRewrite: "chronic congestion",
      startOffset: 37,
      endOffset: 47,
    };
    const segments = segmentParagraphWithSpans(paragraph, [
      span,
      { ...span, id: "bus", startOffset: 67, endOffset: 77 },
    ], "ALL");
    expect(segments.map((segment) => segment.text)).toEqual([
      '<div title="congestion">Rail reduces ', "congestion", ". Buses also reduce ", "congestion", ".</div>",
    ]);
    expect(segments.flatMap((segment) => segment.kind === "span" ? [segment.span.id] : [])).toEqual(["rail", "bus"]);
  });

  it("only searches prose when a span has missing or invalid offsets", () => {
    const paragraph = '<div title="congestion">Rail reduces congestion.</div>';
    const span = {
      id: "rail",
      paragraphIndex: 0,
      excerpt: "congestion",
      criterion: "LR" as const,
      diagnosis: "精准搭配。",
      upgradeRewrite: "chronic congestion",
    };
    for (const candidate of [span, { ...span, startOffset: 37.5, endOffset: 47.5 }]) {
      expect(segmentParagraphWithSpans(paragraph, [candidate], "ALL").map((segment) => segment.text)).toEqual([
        '<div title="congestion">Rail reduces ', "congestion", ".</div>",
      ]);
    }
  });
  it("normalizes invisible Unicode format, combining, and variation-selector characters identically", () => {
    const clean = "High-capacity rail helps alleviate chronic congestion across dense districts.";
    const obfuscated =
      "High-capacity ra\uFE0Fil helps alle\u200Bviate chro\u200Dnic con\u{E0100}gestion acro\u2060ss de\uFEFFnse distri\u0301cts.";
    expect(normalizeAssistedTextKey(obfuscated)).toBe(normalizeAssistedTextKey(clean));
  });

  it("detects copied exemplar paragraphs, near-verbatim passages, and 9-word shingles without flagging short connectors or original prose", () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const writingFingerprints = collectAssistedFingerprints([
      fixture.draft1.paragraphs.join("\n\n"),
      fixture.draft2.paragraphs.join("\n\n"),
      ...Object.values(fixture.draft1Receipt.criteria).flatMap((c) =>
        c.evidenceSpans.map((span) => span.upgradeRewrite),
      ),
      ...Object.values(fixture.draft2Receipt.criteria).flatMap((c) =>
        c.evidenceSpans.map((span) => span.upgradeRewrite),
      ),
    ]);
    const originalParagraphs = GENUINE_ORIGINAL_WRITING_ESSAY.split("\n\n");

    // 1 verbatim paragraph from 4-paragraph draft2 surrounded by 3 brand-new original paragraphs MUST be detected.
    const hybridDraft2Copy = [
      originalParagraphs[0]!,
      fixture.draft2.paragraphs[1]!,
      originalParagraphs[2]!,
      originalParagraphs[3]!,
    ].join("\n\n");
    expect(matchesAssistedFingerprint(hybridDraft2Copy, writingFingerprints)).toBe(true);

    // 1 verbatim paragraph from 4-paragraph draft1 surrounded by 3 brand-new original paragraphs MUST be detected.
    const hybridDraft1Copy = [
      originalParagraphs[0]!,
      originalParagraphs[1]!,
      fixture.draft1.paragraphs[2]!,
      originalParagraphs[3]!,
    ].join("\n\n");
    expect(matchesAssistedFingerprint(hybridDraft1Copy, writingFingerprints)).toBe(true);

    // Near-verbatim substantive sentence copy with minor word swaps breaking 9-word shingles (>= 80% local containment).
    const nearVerbatimRewrite = [
      originalParagraphs[0]!,
      "As metropolitan populations expand swiftly, municipal authorities face a tough allocation choice between widening road corridors and financing urban rail transit.",
      originalParagraphs[2]!,
      originalParagraphs[3]!,
    ].join("\n\n");
    expect(matchesAssistedFingerprint(nearVerbatimRewrite, writingFingerprints)).toBe(true);

    // Short 7-word cue fingerprint catches verbatim reuse of a 7-word cue.
    const shortCueFingerprints = collectAssistedFingerprints([
      "Prioritise electrified commuter corridors over motorway widening",
    ]);
    expect(
      matchesAssistedFingerprint(
        "Municipal planners should prioritise electrified commuter corridors over motorway widening to sustain growth.",
        shortCueFingerprints,
      ),
    ).toBe(true);

    // Common short IELTS connectors (< 7 words) and genuinely original prose MUST NOT false-positive.
    for (const connector of [
      "On the other hand",
      "In conclusion",
      "For example",
      "In the long run",
      "On the other hand, in conclusion, for example, cities must plan carefully.",
    ]) {
      expect(matchesAssistedFingerprint(connector, writingFingerprints)).toBe(false);
    }
    expect(matchesAssistedFingerprint(GENUINE_ORIGINAL_WRITING_ESSAY, writingFingerprints)).toBe(false);

    const speakingFingerprints = collectAssistedFingerprints([
      fixture.initialSpeakingTranscript,
      ...fixture.speakingSeed.argumentBridgeCues,
    ]);
    expect(matchesAssistedFingerprint(GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT, speakingFingerprints)).toBe(false);
  });
});

describe("IeltsDraftCritiqueWorkbench", () => {
  it("gates draft1, draft2, exemplars, and mastery before submission in default learner mode, and latches scaffold reveal across reset", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    await act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated })),
    );

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe("");
    expect(host.querySelector("[data-word-count]")?.textContent).toMatch(/^0 词/u);
    expect(host.querySelector("[data-overall-band]")).toBeNull();
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();
    expect(host.querySelector("[data-epistemic-badge]")).toBeNull();
    expect(host.querySelector('[data-submission-state="unsubmitted"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-exemplar-rewrite]")).toHaveLength(0);
    expect(host.textContent).not.toContain("long-term fiscal viability");
    expect(host.textContent).not.toContain("With the rapid development of modern cities");
    expect(host.textContent).not.toContain(fixture.draft1Receipt.criteria.TR.evidenceSpans[0]!.upgradeRewrite);
    expect(host.textContent).not.toContain(fixture.draft2Receipt.criteria.LR.evidenceSpans[0]!.upgradeRewrite);

    // Step-2 regression [P1-1]: opening the draft1 tab before submission MUST NOT expose
    // the fixture's 4-paragraph draft1 sample essay and keeps the learner's attempt unassisted.
    const draft1Tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === "一稿",
    )!;
    await act(async () => draft1Tab.click());
    expect(host.querySelector('[data-draft1-gated="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain("With the rapid development of modern cities");
    expect(host.querySelector("[data-word-count]")?.textContent).toMatch(/^0 词/u);
    const preRevealCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(preRevealCheckbox.checked).toBe(false);
    expect(preRevealCheckbox.disabled).toBe(false);

    // Pasting the built-in fixture draft2 directly into default learner mode is caught upfront by sample fingerprints.
    await act(async () => setNativeInputValue(textarea!, fixture.draft2.paragraphs.join("\n\n")));
    expect(preRevealCheckbox.checked).toBe(true);
    expect(preRevealCheckbox.disabled).toBe(true);

    // Explicit full reset (before scaffold reveal) lets a genuinely original independent essay earn mastery.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const independentTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const independentCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(independentTextarea.value).toBe("");
    expect(independentCheckbox.checked).toBe(false);
    expect(independentCheckbox.disabled).toBe(false);
    await act(async () => setNativeInputValue(independentTextarea, GENUINE_ORIGINAL_WRITING_ESSAY));
    expect(independentCheckbox.checked).toBe(false);
    expect(independentCheckbox.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(1);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: false }),
      receipt: expect.objectContaining({
        epistemicStatus: "rubric_verified_evidence",
        masteryQualified: true,
        countsTowardMastery: true,
      }),
    });
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();

    // Clicking [data-reveal-scaffold] reveals draft1 + rewrites and latches the active attempt,
    // while clicking [data-reset-attempt] resets the attempt latch for a genuinely fresh independent essay
    // yet retains fingerprints of revealed samples & prior scaffold-assisted drafts.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const revealBtn = host.querySelector<HTMLButtonElement>("[data-reveal-scaffold]")!;
    await act(async () => revealBtn.click());
    expect(host.querySelector('[data-writing-scaffold="true"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-exemplar-rewrite]").length).toBeGreaterThan(0);
    expect(host.querySelector('[data-draft1-gated="true"]')).toBeNull();
    expect(host.textContent).toContain("With the rapid development of modern cities");
    const latchedCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(latchedCheckbox.checked).toBe(true);
    expect(latchedCheckbox.disabled).toBe(true);

    // Draft a scaffold-assisted response before resetting; its fingerprint must persist across reset.
    const priorScaffoldDraft =
      "Municipal planners should evaluate suburban commuter corridors carefully before committing tax funds to extra highway lanes.";
    const openTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    await act(async () => setNativeInputValue(openTextarea, priorScaffoldDraft));

    // Clicking [data-reset-attempt] clears inputs, re-gates draft1, and unlocks the fresh attempt.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const afterRevealResetTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const afterRevealResetCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(afterRevealResetTextarea.value).toBe("");
    expect(afterRevealResetCheckbox.checked).toBe(false);
    expect(afterRevealResetCheckbox.disabled).toBe(false);
    expect(host.querySelector('[data-writing-scaffold="true"]')).toBeNull();
    expect(host.querySelector('[data-draft1-gated="true"]')).not.toBeNull();

    // Pasting the revealed sample (draft2) or the prior scaffold-assisted draft STILL re-latches assistance.
    await act(async () => setNativeInputValue(afterRevealResetTextarea, priorScaffoldDraft));
    expect(afterRevealResetCheckbox.checked).toBe(true);
    expect(afterRevealResetCheckbox.disabled).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    await act(async () => setNativeInputValue(
      host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!,
      fixture.draft2.paragraphs.join("\n\n"),
    ));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);

    // Resetting and submitting a genuinely new original essay evaluates as unassisted / independent.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const freshWritingTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const freshWritingCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => setNativeInputValue(freshWritingTextarea, GENUINE_ORIGINAL_WRITING_ESSAY));
    expect(freshWritingCheckbox.checked).toBe(false);
    expect(freshWritingCheckbox.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: false }),
      receipt: expect.objectContaining({
        epistemicStatus: "rubric_verified_evidence",
        masteryQualified: true,
        countsTowardMastery: true,
      }),
    });
  });

  it("allows opt-in demoFixtureMode preview without ever displaying verified learner mastery", async () => {
    await act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { demoFixtureMode: true })),
    );
    expect(host.querySelector('[data-demo-preview="true"]')).not.toBeNull();
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')?.textContent).toContain("示例预览");
    expect(host.textContent).not.toContain("量规复核证据 · 跨稿迁移已确认");
    expect(host.querySelectorAll("[data-exemplar-rewrite]").length).toBeGreaterThan(0);
  });

  it("reuses the current Writing receipt until the revision changes", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    await act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { fixture, onRevisionEvaluated })),
    );
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

  it.each(["targets", "baseline text", "revision text"] as const)(
    "rejects saved Writing evidence after changing %s under the same IDs",
    async (change) => {
      const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
      const targets = change === "targets" ? fixture.targets.map((target) => ({
        ...target, targetPatterns: ["affordable housing"],
      })) : fixture.targets;
      const draft1 = change === "baseline text" ? { ...fixture.draft1, paragraphs: ["<input disabled>"] } : fixture.draft1;
      const draft2 = change === "revision text" ? { ...fixture.draft2, paragraphs: ["A short and unrelated revision."] } : fixture.draft2;
      const onRevisionEvaluated = vi.fn();
      const render = (nextFixture: typeof fixture) => act(async () => root.render(createElement(
        IeltsDraftCritiqueWorkbench, { fixture: nextFixture, onRevisionEvaluated },
      )));
      await render(fixture);
      expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();
      expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 4 / 4");

      await render({ ...fixture, targets, draft1, draft2 });
      expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
      expect(host.querySelector("[data-transfer-summary]")?.textContent).toContain("已迁移 0 / 4");
      await act(async () => writingButton("打开改写编辑区").click());
      await act(async () => writingButton("重新分析改写").click());
      expect(onRevisionEvaluated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        receipt: expect.objectContaining({ masteryQualified: false }),
      }));
    },
  );

  it("requires a new Writing receipt even if a changed target definition still transfers", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const targets = fixture.targets.map((target) => ({ ...target, guidance: "Use this expression in a new context." }));
    const next = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1, revisedDraft: fixture.draft2, targets, receiptId: fixture.draft2Receipt.receiptId,
    });
    if (!next.ok) throw new Error("Expected a receipt for the existing Writing draft");
    expect(next.transferReport.summary.transferredCount).toBe(4);
    const render = (nextFixture: typeof fixture) => act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { fixture: nextFixture })));
    await render({ ...fixture, targets, transferReport: next.transferReport });
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
    await render({ ...fixture, targets, transferReport: next.transferReport, draft2Receipt: next.receipt });
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();
  });

  it("asks for English text when a punctuation-only revision is submitted", async () => {
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated })));
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const submitBtn = () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!;
    await act(async () => setNativeInputValue(textarea, "..."));
    await act(async () => submitBtn().click());
    expect(onRevisionEvaluated).not.toHaveBeenCalled();
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent).toContain("英文单词");

    await act(async () => setNativeInputValue(textarea, "The council plans to extend rail service."));
    await act(async () => submitBtn().click());
    expect(onRevisionEvaluated).toHaveBeenCalledOnce();
    expect(textarea.getAttribute("aria-invalid")).not.toBe("true");
  });
  it("renders Draft 2 verified evidence, switches to Draft 1 practice feedback and comparison view", async () => {
    await act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { fixture: IELTS_WRITING_SPEAKING_FIXTURE })),
    );

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
        createElement(IeltsDraftCritiqueWorkbench, {
          fixture: IELTS_WRITING_SPEAKING_FIXTURE,
          onRevisionEvaluated,
        }),
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

  it("keeps a loaded assisted Writing revision sticky until the essay text genuinely changes", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const assistedDraft2 = { ...fixture.draft2, draftId: "assisted-qualifying-draft-2", assisted: true };
    const evaluated = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: assistedDraft2,
      targets: fixture.targets,
      receiptId: "assisted-qualifying-receipt",
    });
    if (!evaluated.ok) throw new Error("Expected a practice receipt for the assisted qualifying draft");
    const assistedFixture = {
      ...fixture,
      draft2: assistedDraft2,
      draft2Receipt: evaluated.receipt,
      transferReport: evaluated.transferReport,
    };
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, {
      fixture: assistedFixture,
      onRevisionEvaluated,
    })));
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();

    await act(async () => writingButton("打开改写编辑区").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Attempting to uncheck and reanalyze the same text must not promote mastery.
    await act(async () => checkbox.click());
    await act(async () => writingButton("重新分析改写").click());
    expect(checkbox.checked).toBe(true);
    expect(onRevisionEvaluated).not.toHaveBeenCalled();
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();

    // Whitespace-only tweaks on the same assisted text must still evaluate as assisted.
    const originalText = textarea.value;
    await act(async () => setNativeInputValue(textarea, `${originalText}   \n\n`));
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(1);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      }),
    });

    // Partial edits (appending a sentence) must NOT clear latched assistance on the same attempt.
    const independentText = `${originalText} Transparent multi-year transit funding also helps local authorities plan depot upgrades steadily.`;
    await act(async () => setNativeInputValue(textarea, independentText));
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(2);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      }),
    });

    // Explicit full reset clears to "" and starts a fresh unassisted attempt.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const resetTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const resetCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(resetTextarea.value).toBe("");
    expect(resetCheckbox.disabled).toBe(false);
    expect(resetCheckbox.checked).toBe(false);

    // Pasting the assisted text back after full reset still re-engages sticky assistance.
    await act(async () => setNativeInputValue(resetTextarea, originalText));
    expect(resetCheckbox.checked).toBe(true);
    expect(resetCheckbox.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(3);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      }),
    });

    // Explicit full reset followed by genuinely original independent prose earns verified mastery.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const freshTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const freshCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => setNativeInputValue(freshTextarea, GENUINE_ORIGINAL_WRITING_ESSAY));
    expect(freshCheckbox.disabled).toBe(false);
    expect(freshCheckbox.checked).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(4);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: false }),
      receipt: expect.objectContaining({
        epistemicStatus: "rubric_verified_evidence",
        masteryQualified: true,
        countsTowardMastery: true,
      }),
    });
  });

  it("keeps a locally evaluated assisted Writing revision sticky and resets cleanly on a new fixture", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, {
      fixture,
      onRevisionEvaluated,
    })));
    await act(async () => writingButton("打开改写编辑区").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const localAssistedText = `${textarea.value} Clear timetable coordination also reduces commuter transfers.`;

    await act(async () => setNativeInputValue(textarea, localAssistedText));
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(1);
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        countsTowardMastery: false,
      }),
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Trying to uncheck and reanalyze the same text keeps practice_feedback.
    await act(async () => checkbox.click());
    await act(async () => writingButton("重新分析改写").click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-epistemic-badge="practice_feedback"]')).not.toBeNull();
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).toBeNull();

    // Switching to a genuinely different unassisted fixture clears previous local sticky state.
    const nextDraft2 = {
      ...fixture.draft2,
      draftId: "fresh-unassisted-attempt",
      paragraphs: localAssistedText.split("\n\n"),
      assisted: false,
    };
    const nextEval = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: nextDraft2,
      targets: fixture.targets,
      receiptId: "fresh-unassisted-receipt",
    });
    if (!nextEval.ok) throw new Error("Expected a verified receipt for the new unassisted fixture");
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, {
      fixture: {
        ...fixture,
        draft2: nextDraft2,
        draft2Receipt: nextEval.receipt,
        transferReport: nextEval.transferReport,
      },
      onRevisionEvaluated,
    })));
    expect(host.querySelector('[data-epistemic-badge="rubric_verified_evidence"]')).not.toBeNull();
    await act(async () => writingButton("打开改写编辑区").click());
    const resetCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(resetCheckbox.checked).toBe(false);
    expect(resetCheckbox.disabled).toBe(false);
  });

  it("blocks punctuation-adjacent whitespace, punctuation, casing, and non-lexical bypasses on sticky-assisted Writing drafts", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const assistedDraft2 = { ...fixture.draft2, draftId: "assisted-punct-writing-draft", assisted: true };
    const evaluated = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: assistedDraft2,
      targets: fixture.targets,
      receiptId: "assisted-punct-writing-receipt",
    });
    if (!evaluated.ok) throw new Error("Expected a practice receipt for the assisted Writing draft");
    const onRevisionEvaluated = vi.fn();
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, {
      fixture: {
        ...fixture,
        draft2: assistedDraft2,
        draft2Receipt: evaluated.receipt,
        transferReport: evaluated.transferReport,
      },
      onRevisionEvaluated,
    })));
    await act(async () => writingButton("打开改写编辑区").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const originalText = textarea.value;
    expect(originalText).toContain("rapidly,");

    const cosmeticVariants = [
      originalText.replace("rapidly,", "rapidly ,"),
      originalText.replace("rapidly,", "RAPIDLY;"),
      `${originalText.replace("rapidly,", "rapidly").replace(/\n\n/gu, "\n")} <!-- note --> 123`,
      originalText.replace("rapidly", "ra\uFE0Fpidly"),
      originalText.replace("rapidly", "ra\u200Bpidly"),
      originalText.replace("rapidly", "ra\u{E0100}pidly"),
      originalText.replace("rapidly", "ra\u200Dpi\u0301dly"),
      `${originalText} Dedicated commuter rail funding also stabilises multi-year maintenance budgets.`,
    ];
    for (const [index, variant] of cosmeticVariants.entries()) {
      await act(async () => setNativeInputValue(textarea, variant));
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(true);
      await act(async () => checkbox.click());
      await act(async () => writingButton("重新分析改写").click());
      expect(onRevisionEvaluated).toHaveBeenCalledTimes(index + 1);
      expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
        revisedDraft: expect.objectContaining({ assisted: true }),
        receipt: expect.objectContaining({
          epistemicStatus: "practice_feedback",
          masteryQualified: false,
          countsTowardMastery: false,
        }),
      });
    }

    // Even after explicit full reset, pasting back a variation-selector / ZWSP mutated copy still re-locks assistance.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const resetTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const resetCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(resetTextarea.value).toBe("");
    expect(resetCheckbox.disabled).toBe(false);
    expect(resetCheckbox.checked).toBe(false);

    await act(async () =>
      setNativeInputValue(
        resetTextarea,
        originalText.replace("rapidly", "ra\uFE0Fpi\u200Bd\u{E0100}ly"),
      ),
    );
    expect(resetCheckbox.disabled).toBe(true);
    expect(resetCheckbox.checked).toBe(true);

    // Appending after pasting back the assisted copy stays latched until another explicit full reset.
    await act(async () =>
      setNativeInputValue(
        resetTextarea,
        `${originalText} Appending after pasting assisted text must stay locked.`,
      ),
    );
    expect(resetCheckbox.disabled).toBe(true);
    expect(resetCheckbox.checked).toBe(true);

    // Explicit full reset followed by lightly editing the assisted draft STILL re-locks assistance via fingerprint overlap.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const lightlyEditedTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const lightlyEditedCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () =>
      setNativeInputValue(
        lightlyEditedTextarea,
        `${originalText} Long-horizon public rail budgets also prevent disruptive fare spikes for urban commuters.`,
      ),
    );
    expect(lightlyEditedCheckbox.disabled).toBe(true);
    expect(lightlyEditedCheckbox.checked).toBe(true);

    // Explicit full reset followed by genuinely original independent prose earns verified mastery.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const freshTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const freshCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => setNativeInputValue(freshTextarea, GENUINE_ORIGINAL_WRITING_ESSAY));
    expect(freshCheckbox.disabled).toBe(false);
    expect(freshCheckbox.checked).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: false }),
      receipt: expect.objectContaining({
        epistemicStatus: "rubric_verified_evidence",
        masteryQualified: true,
        countsTowardMastery: true,
      }),
    });
  });

  it("initializes Writing composer checkbox cleanly when sticky assistance starts from mismatched receipt provenance", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const assistedDraft2 = { ...fixture.draft2, draftId: "mismatched-writing-draft", assisted: true };
    const evaluated = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: assistedDraft2,
      targets: fixture.targets,
      receiptId: "mismatched-writing-receipt",
    });
    if (!evaluated.ok) throw new Error("Expected a practice receipt for the assisted Writing draft");
    await act(async () => root.render(createElement(IeltsDraftCritiqueWorkbench, {
      fixture: {
        ...fixture,
        draft2: { ...assistedDraft2, assisted: false },
        draft2Receipt: evaluated.receipt,
        transferReport: evaluated.transferReport,
      },
    })));
    await act(async () => writingButton("打开改写编辑区").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Partial edits cannot clear latched assistance; only explicit full reset starts a fresh unassisted attempt.
    await act(async () => setNativeInputValue(
      textarea,
      `${textarea.value} Clear capital planning also prevents sudden fare spikes.`,
    ));
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it("tracks post-submit draft1 and critique rewrites and flags a single copied exemplar paragraph surrounded by original prose", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onRevisionEvaluated = vi.fn();
    await act(async () =>
      root.render(createElement(IeltsDraftCritiqueWorkbench, { onRevisionEvaluated })),
    );

    // Attempt #1: submit a short independent draft WITHOUT clicking [data-reveal-scaffold].
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    await act(async () =>
      setNativeInputValue(
        textarea,
        "Municipal budgets should support electric suburban trains so daily commuters face fewer delays.",
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated).toHaveBeenCalledTimes(1);
    const firstReceipt = onRevisionEvaluated.mock.lastCall?.[0]?.receipt;
    expect(firstReceipt?.sourceDraft?.assisted).toBe(false);
    const displayedCritiqueRewrite = firstReceipt?.criteria.LR.evidenceSpans[0]?.upgradeRewrite;
    expect(displayedCritiqueRewrite).toBeTruthy();

    // Reset and submit 3 distinct paragraphs + 1 copied paragraph from unlocked draft1.
    const fillerParagraphs = [
      "Urban infrastructure budgets require careful trade-offs between long-lived electric rail corridors and incremental asphalt widening across fast-expanding metropolitan districts.",
      "Public planners often weigh construction lead times against commuter throughput when deciding how regional ministries distribute annual transport capital.",
      "Coordinating local shuttle fleets with suburban transit hubs lets residents reach city workplaces without expanding downtown parking lots.",
    ];
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const resetTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const resetCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(resetCheckbox.checked).toBe(false);
    expect(resetCheckbox.disabled).toBe(false);

    const oneCopiedDraft1Paragraph = [
      fillerParagraphs[0]!,
      fixture.draft1.paragraphs[1]!,
      fillerParagraphs[1]!,
      fillerParagraphs[2]!,
    ].join("\n\n");
    await act(async () => setNativeInputValue(resetTextarea, oneCopiedDraft1Paragraph));
    expect(resetCheckbox.checked).toBe(true);
    expect(resetCheckbox.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      }),
    });

    // Reset and paste a post-submit critique upgradeRewrite embedded inside distinct paragraphs.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const rewriteTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const rewriteCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () =>
      setNativeInputValue(
        rewriteTextarea,
        [fillerParagraphs[0]!, `${fillerParagraphs[1]!} ${displayedCritiqueRewrite}`, fillerParagraphs[2]!].join("\n\n"),
      ),
    );
    expect(rewriteCheckbox.checked).toBe(true);
    expect(rewriteCheckbox.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: true }),
      receipt: expect.objectContaining({
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      }),
    });

    // Reset and submit genuinely fresh original prose -> verified mastery!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const cleanTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="二稿改写编辑区"]')!;
    const cleanCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => setNativeInputValue(cleanTextarea, GENUINE_ORIGINAL_WRITING_ESSAY));
    expect(cleanCheckbox.checked).toBe(false);
    expect(cleanCheckbox.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-submit-writing]")!.click());
    expect(onRevisionEvaluated.mock.lastCall?.[0]).toMatchObject({
      revisedDraft: expect.objectContaining({ assisted: false }),
      receipt: expect.objectContaining({
        epistemicStatus: "rubric_verified_evidence",
        masteryQualified: true,
        countsTowardMastery: true,
      }),
    });
  });
});

describe("IeltsSpeakingTransferCard", () => {
  it("strips demo verified Writing receipt on default learner mount and blocks reveal-copy-reset-paste bypass even with a real verified Writing receipt", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onEvaluated = vi.fn();
    await act(async () =>
      root.render(createElement(IeltsSpeakingTransferCard, { onEvaluated })),
    );

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    expect(textarea.value).toBe("");
    expect(durationInput.value).toBe("");
    expect(host.querySelector("[data-speaking-epistemic]")).toBeNull();
    expect(host.querySelectorAll("[data-speaking-quote]")).toHaveLength(0);
    expect(host.querySelector('[data-speaking-scaffold="true"]')).toBeNull();
    expect(host.querySelector("[data-speaking-sample-transcript]")).toBeNull();
    expect(host.textContent).not.toContain(fixture.initialSpeakingTranscript);
    expect(host.textContent).not.toContain(fixture.speakingSeed.argumentBridgeCues[0]!);

    // Submitting an empty transcript must NOT unlock scaffold cues or exemplars.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-speaking-evaluate]")!.click());
    expect(host.querySelector('[data-speaking-scaffold="true"]')).toBeNull();
    expect(host.textContent).not.toContain(fixture.speakingSeed.argumentBridgeCues[0]!);

    // Step-2 regression [P1-2]: default learner mount MUST NOT inherit the demo's verified Writing receipt.
    await act(async () => {
      setNativeInputValue(textarea, GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT);
      setNativeInputValue(durationInput, "78");
    });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-speaking-evaluate]")!.click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: false,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });
    expect(onEvaluated.mock.lastCall?.[0]?.evaluationContext?.writingReceiptEligible).toBe(false);

    // Now mount with a real learner verifiedWritingReceipt prop.
    await act(async () =>
      root.render(
        createElement(IeltsSpeakingTransferCard, {
          key: "with-real-writing-receipt",
          verifiedWritingReceipt: fixture.draft2Receipt,
          onEvaluated,
        }),
      ),
    );
    const verifiedTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const verifiedDuration = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;

    // Explicit scaffold reveal -> copy sample -> reset -> paste sample at 78s MUST stay assisted!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reveal-scaffold]")!.click());
    expect(host.querySelector('[data-speaking-scaffold="true"]')).not.toBeNull();
    const revealedSample = host.querySelector("[data-speaking-sample-transcript]")!.textContent!;
    expect(revealedSample).toContain("alleviate chronic congestion");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Click reset: current attempt latch resets to independent (false), scaffold hides,
    // while fingerprints of the revealed sample & any scaffold-assisted draft persist across reset.
    const priorScaffoldSpeech =
      "My first assisted note while viewing the scaffold mentions commuter trains and local bus feeders.";
    await act(async () => setNativeInputValue(verifiedTextarea, priorScaffoldSpeech));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(verifiedTextarea.value).toBe("");
    expect(verifiedDuration.value).toBe("");
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(host.querySelector('[data-speaking-scaffold="true"]')).toBeNull();

    // Pasting the revealed sample back at 78s STILL latches assisted & produces practice_feedback!
    await act(async () => {
      setNativeInputValue(verifiedTextarea, revealedSample);
      setNativeInputValue(verifiedDuration, "78");
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-speaking-evaluate]")!.click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Pasting the prior scaffold-assisted transcript after another reset STILL latches assisted!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    await act(async () => setNativeInputValue(verifiedTextarea, priorScaffoldSpeech));
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Step-2 regression [P1-1]: Resetting on the SAME seed and submitting a genuinely brand-new
    // independent response + duration evaluates as unassisted and qualifies for verified mastery!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    await act(async () => {
      setNativeInputValue(verifiedTextarea, GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT);
      setNativeInputValue(verifiedDuration, "76");
    });
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-speaking-evaluate]")!.click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: false,
      epistemicStatus: "rubric_verified_evidence",
      masteryQualified: true,
      countsTowardMastery: true,
    });

    // On a fresh seed mount without clicking reveal: pasting built-in sample is still blocked upfront.
    await act(async () =>
      root.render(
        createElement(IeltsSpeakingTransferCard, {
          key: "fresh-unrevealed-attempt",
          verifiedWritingReceipt: fixture.draft2Receipt,
          onEvaluated,
        }),
      ),
    );
    const freshTextarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const freshDuration = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    const freshCheckbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      setNativeInputValue(freshTextarea, fixture.initialSpeakingTranscript);
      setNativeInputValue(freshDuration, "78");
    });
    expect(freshCheckbox.checked).toBe(true);
    expect(freshCheckbox.disabled).toBe(true);
  });

  it("allows opt-in demoFixtureMode preview on Speaking without ever displaying verified learner mastery", async () => {
    await act(async () =>
      root.render(createElement(IeltsSpeakingTransferCard, { demoFixtureMode: true })),
    );
    expect(host.querySelector('[data-demo-preview="true"]')).not.toBeNull();
    expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();
    expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')?.textContent).toContain("示例预览");
    expect(host.textContent).not.toContain("口语转写迁移已确认");
    expect(host.querySelectorAll("[data-speaking-signal]")).toHaveLength(4);
  });
  it.each(["receipt only", "transcript, duration and receipt"] as const)(
    "keeps freshly generated Speaking feedback when a controlled host writes back %s", async (writeBack) => {
      const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
      function ControlledHost({ revoked }: { revoked: boolean }) {
        const [receipt, setReceipt] = useState<typeof fixture.initialSpeakingReceipt>();
        const savedAnswer = writeBack === "transcript, duration and receipt" ? receipt : undefined;
        return createElement(IeltsSpeakingTransferCard, {
          seed: fixture.speakingSeed,
          initialTranscript: savedAnswer?.sourceTranscript ?? fixture.initialSpeakingTranscript,
          initialDurationSeconds: savedAnswer?.durationSeconds ?? fixture.initialSpeakingDurationSeconds,
          initialReceipt: revoked ? undefined : receipt,
          onEvaluated: (nextReceipt: typeof fixture.initialSpeakingReceipt) => {
            const { createdAt, ...rest } = structuredClone(nextReceipt);
            setReceipt({ createdAt, ...rest });
          },
        });
      }

      await act(async () => root.render(createElement(ControlledHost, { revoked: false })));
      await act(async () => {
        setNativeInputValue(
          host.querySelector<HTMLTextAreaElement>("textarea")!,
          `${fixture.initialSpeakingTranscript} Actually, rail remains the practical choice.`,
        );
        setNativeInputValue(host.querySelector<HTMLInputElement>('input[type="number"]')!, "75");
      });
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());

      expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).not.toBeNull();
      expect(host.querySelector('[data-speaking-pace="on_target"]')).not.toBeNull();
      await act(async () => root.render(createElement(ControlledHost, { revoked: true })));
      expect(host.querySelector("[data-speaking-epistemic]")).toBeNull();
    },
  );

  it.each(["receipt only", "complete attempt"] as const)(
    "keeps an edited answer assisted on reevaluation after the host returns %s", async (writeBack) => {
      const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
      const seed = fixture.speakingSeed;
      const transcript = `${fixture.initialSpeakingTranscript} That is why I would choose rail.`;
      const durationSeconds = 75;
      const onEvaluated = vi.fn<(receipt: typeof fixture.initialSpeakingReceipt) => void>();
      const render = (receipt?: typeof fixture.initialSpeakingReceipt) => {
        const savedAnswer = writeBack === "complete attempt" ? receipt : undefined;
        return act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
          seed, onEvaluated, initialReceipt: receipt,
          initialTranscript: savedAnswer?.sourceTranscript ?? fixture.initialSpeakingTranscript,
          initialDurationSeconds: savedAnswer?.durationSeconds ?? fixture.initialSpeakingDurationSeconds,
        })));
      };
      await render();
      await act(async () => {
        setNativeInputValue(host.querySelector<HTMLTextAreaElement>("textarea")!, transcript);
        setNativeInputValue(host.querySelector<HTMLInputElement>('input[type="number"]')!, String(durationSeconds));
      });
      const evaluate = () => act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      await evaluate();
      expect(onEvaluated.mock.lastCall?.[0].countsTowardMastery).toBe(true);

      await render(evaluateSpeakingRetelling({ seed, transcript, durationSeconds, assisted: true }));
      const checkedBeforeReevaluation = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked;
      await evaluate();
      expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
        sourceTranscript: transcript, durationSeconds, assisted: true, epistemicStatus: "practice_feedback",
        masteryQualified: false, countsTowardMastery: false,
      });
      expect(checkedBeforeReevaluation).toBe(true);
      expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
    },
  );

  it.each(["transcript", "duration", "practice feedback", "mastery flag", "assistance", "removal"] as const)(
    "discards generated Speaking mastery after the host changes %s on the same seed",
    async (change) => {
      const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
      const onEvaluated = vi.fn<(receipt: typeof fixture.initialSpeakingReceipt) => void>();
      const props = {
        seed: fixture.speakingSeed,
        initialTranscript: fixture.initialSpeakingTranscript,
        initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
        onEvaluated,
      };
      const render = (overrides: Partial<Parameters<typeof IeltsSpeakingTransferCard>[0]> = {}) =>
        act(async () => root.render(createElement(IeltsSpeakingTransferCard, { ...props, ...overrides })));
      await render();
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      const emitted = onEvaluated.mock.calls[0]![0];
      await render({ initialReceipt: structuredClone(emitted) });
      expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).not.toBeNull();

      if (change === "transcript") {
        await render({ initialTranscript: "Rail is my recommendation.", initialReceipt: emitted });
      } else if (change === "duration") {
        await render({ initialDurationSeconds: 20, initialReceipt: emitted });
      } else if (change === "practice feedback") {
        await render({ initialReceipt: { ...emitted, epistemicStatus: "practice_feedback", masteryQualified: false, countsTowardMastery: false } });
        expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
      } else if (change === "mastery flag") {
        await render({ initialReceipt: { ...emitted, masteryQualified: false } });
      } else if (change === "assistance") {
        await render({ initialReceipt: { ...emitted, assisted: true } });
      } else {
        await render();
      }
      expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();
      await render();
      expect(host.querySelector("[data-speaking-epistemic]")).toBeNull();
    },
  );

  it("never shows verified Speaking evidence for an assisted initial receipt", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed: fixture.speakingSeed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
      initialReceipt: { ...fixture.initialSpeakingReceipt, assisted: true },
    })));

    expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();
  });

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

  it.each(["targets", "time window", "Writing receipt", "Speaking receipt"] as const)(
    "preserves the in-progress Speaking answer after a refresh of %s",
    async (change) => {
      const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
      const seed = fixture.speakingSeed;
      const nextSeed: typeof seed = change === "targets" ? { ...seed, targetSpokenCollocations: ["affordable housing"] }
        : change === "time window" ? { ...seed, timeWindowSeconds: { ...seed.timeWindowSeconds, max: 70 as 90 } }
          : change === "Writing receipt" ? { ...seed, verifiedWritingReceipt: undefined } : seed;
      const initialReceipt = fixture.initialSpeakingReceipt;
      const nextReceipt = change === "Speaking receipt" ? { ...initialReceipt, assisted: true } : initialReceipt;
      const onEvaluated = vi.fn();
      const render = (currentSeed: typeof seed, receipt: typeof initialReceipt) => act(async () =>
        root.render(createElement(IeltsSpeakingTransferCard, {
          seed: currentSeed, initialTranscript: fixture.initialSpeakingTranscript, initialReceipt: receipt, onEvaluated,
        })));
      await render(seed, initialReceipt);
      expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).not.toBeNull();
      await act(async () => {
        setNativeInputValue(host.querySelector<HTMLTextAreaElement>("textarea")!, "My unfinished answer");
        setNativeInputValue(host.querySelector<HTMLInputElement>('input[type="number"]')!, "75");
      });
      await render(nextSeed, nextReceipt);
      expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("My unfinished answer");
      expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("75");
      expect(host.querySelector("[data-speaking-epistemic]")).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
      expect(onEvaluated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sourceTranscript: "My unfinished answer",
        durationSeconds: 75,
        assisted: change === "Speaking receipt",
        masteryQualified: false,
      }));
    },
  );

  it("invalidates Speaking pace feedback when the time window changes", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const seed = fixture.speakingSeed;
    const render = (currentSeed: typeof seed) => act(async () =>
      root.render(createElement(IeltsSpeakingTransferCard, {
        seed: currentSeed, initialTranscript: fixture.initialSpeakingTranscript, initialReceipt: fixture.initialSpeakingReceipt,
      })));
    await render(seed);
    expect(host.querySelector('[data-speaking-pace="on_target"]')).not.toBeNull();
    await render({ ...seed, timeWindowSeconds: { ...seed.timeWindowSeconds, max: 70 as 90 } });
    expect(host.querySelector('[data-speaking-pace="on_target"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[data-speaking-pace="over_time"]')).not.toBeNull();
    expect(host.querySelector('[data-speaking-signal="durationCompliance"]')?.textContent).toContain("超过 70 秒上限");
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
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onEvaluated = vi.fn();
    await act(async () =>
      root.render(
        createElement(IeltsSpeakingTransferCard, {
          seed: fixture.speakingSeed,
          initialTranscript: fixture.initialSpeakingTranscript,
          initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
          initialReceipt: fixture.initialSpeakingReceipt,
          onEvaluated,
        }),
      ),
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

  it("keeps a locally evaluated assisted Speaking transcript sticky across uncheck and duration tweaks until edited", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const onEvaluated = vi.fn<(receipt: typeof fixture.initialSpeakingReceipt) => void>();
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed: fixture.speakingSeed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
      onEvaluated,
    })));

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const evaluateBtn = () => host.querySelector<HTMLButtonElement>("button")!;

    // Local evaluation with assisted: true (no host receipt).
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Attempting to uncheck and re-evaluate at the same duration must stay assisted.
    await act(async () => checkbox.click());
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      sourceTranscript: fixture.initialSpeakingTranscript,
      durationSeconds: fixture.initialSpeakingDurationSeconds,
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });
    expect(host.querySelector('[data-speaking-epistemic="practice_feedback"]')).not.toBeNull();
    expect(host.querySelector('[data-speaking-epistemic="rubric_verified_evidence"]')).toBeNull();

    // Tweaking duration or surrounding whitespace on the same assisted transcript must stay assisted.
    await act(async () => {
      setNativeInputValue(durationInput, "75");
      setNativeInputValue(textarea, `  ${fixture.initialSpeakingTranscript}  `);
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      durationSeconds: 75,
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Partial edits (appending a sentence) must NOT clear latched assistance on the same attempt.
    const independentTranscript = `${fixture.initialSpeakingTranscript} On top of that, predictable rail timetables give commuters real confidence.`;
    await act(async () => setNativeInputValue(textarea, independentTranscript));
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      sourceTranscript: independentTranscript,
      durationSeconds: 75,
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Explicit full reset clears to "" and unlocks a fresh unassisted attempt.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(textarea.value).toBe("");
    expect(durationInput.value).toBe("");
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);

    // Pasting the previously assisted transcript back after reset still re-locks assistance.
    await act(async () => {
      setNativeInputValue(textarea, fixture.initialSpeakingTranscript);
      setNativeInputValue(durationInput, "75");
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      sourceTranscript: fixture.initialSpeakingTranscript,
      durationSeconds: 75,
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // After full reset, genuinely original independent speech earns verified mastery.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    await act(async () => {
      setNativeInputValue(textarea, GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT);
      setNativeInputValue(durationInput, "75");
    });
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      sourceTranscript: GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT,
      durationSeconds: 75,
      assisted: false,
      epistemicStatus: "rubric_verified_evidence",
      masteryQualified: true,
      countsTowardMastery: true,
    });
  });

  it("keeps a host-loaded assisted Speaking transcript sticky even after tweaking duration", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const seed = fixture.speakingSeed;
    const assistedReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: fixture.initialSpeakingTranscript,
      durationSeconds: fixture.initialSpeakingDurationSeconds,
      assisted: true,
    });
    const onEvaluated = vi.fn<(receipt: typeof fixture.initialSpeakingReceipt) => void>();
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
      initialReceipt: assistedReceipt,
      onEvaluated,
    })));

    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    await act(async () => setNativeInputValue(durationInput, "72"));
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => checkbox.click());
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      durationSeconds: 72,
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });
  });

  it("hands Speaking answer ownership back to a 3-prop host when an invalid-duration attempt writes back undefined duration", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    function ControlledHost({
      overrideTranscript,
      overrideDuration,
    }: {
      overrideTranscript?: string;
      overrideDuration?: number;
    }) {
      const [receipt, setReceipt] = useState<typeof fixture.initialSpeakingReceipt>();
      return createElement(IeltsSpeakingTransferCard, {
        seed: fixture.speakingSeed,
        initialTranscript: overrideTranscript ?? receipt?.sourceTranscript ?? fixture.initialSpeakingTranscript,
        initialDurationSeconds: overrideDuration ?? (receipt ? (receipt.durationSeconds ?? undefined) : fixture.initialSpeakingDurationSeconds),
        initialReceipt: overrideTranscript ? undefined : receipt,
        onEvaluated: (nextReceipt: typeof fixture.initialSpeakingReceipt) => {
          setReceipt(structuredClone(nextReceipt));
        },
      });
    }

    await act(async () => root.render(createElement(ControlledHost)));
    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    await act(async () => setNativeInputValue(durationInput, ""));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[data-speaking-pace="invalid_duration"]')).not.toBeNull();

    // Because 3-prop write-back handed ownership back to the host, a subsequent host update is not shadowed.
    await act(async () => root.render(createElement(ControlledHost, {
      overrideTranscript: "Fresh host transcript after invalid duration.",
      overrideDuration: 68,
    })));
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value)
      .toBe("Fresh host transcript after invalid duration.");
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("68");
  });

  it("blocks punctuation-adjacent whitespace, punctuation, casing, and non-lexical bypasses on sticky-assisted Speaking transcripts", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const seed = fixture.speakingSeed;
    const assistedReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: fixture.initialSpeakingTranscript,
      durationSeconds: fixture.initialSpeakingDurationSeconds,
      assisted: true,
    });
    const onEvaluated = vi.fn<(receipt: typeof fixture.initialSpeakingReceipt) => void>();
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: fixture.initialSpeakingDurationSeconds,
      initialReceipt: assistedReceipt,
      onEvaluated,
    })));

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const evaluateBtn = () => host.querySelector<HTMLButtonElement>("button")!;
    const original = fixture.initialSpeakingTranscript;
    expect(original).toContain("Personally,");

    const cosmeticVariants = [
      original.replace("Personally,", "Personally ,"),
      original.replace("Personally,", "personally!"),
      `${original.replace("Personally,", "Personally").replace("per-capita", "per - capita")} <!-- note --> 123`,
      original.replace("Personally", "Pers\uFE0Fonally"),
      original.replace("Personally", "Pers\u200Bonally"),
      original.replace("Personally", "Pers\u{E0100}onally"),
      original.replace("Personally", "Pers\u200Do\u0301nally"),
      `${original} Steady investment in rail reliability also makes suburban commutes much more predictable.`,
    ];
    for (const variant of cosmeticVariants) {
      await act(async () => setNativeInputValue(textarea, variant));
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(true);
      await act(async () => checkbox.click());
      await act(async () => evaluateBtn().click());
      expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
        assisted: true,
        epistemicStatus: "practice_feedback",
        masteryQualified: false,
        countsTowardMastery: false,
      });
    }

    // Even after explicit full reset, pasting a variation-selector / ZWSP mutated copy still re-locks assistance.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(textarea.value).toBe("");
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);

    await act(async () =>
      setNativeInputValue(
        textarea,
        original.replace("Personally", "Pers\uFE0Fo\u200Bna\u{E0100}lly"),
      ),
    );
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    // Appending after pasting back the assisted copy stays latched until another explicit full reset.
    await act(async () =>
      setNativeInputValue(
        textarea,
        `${original} Appending after pasting assisted transcript must stay locked.`,
      ),
    );
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    // Explicit full reset followed by lightly editing the assisted transcript STILL re-locks assistance.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    await act(async () => {
      setNativeInputValue(
        textarea,
        `${original} Long-term rail timetables also give suburban workers dependable evening transport.`,
      );
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    // Explicit full reset followed by genuinely original independent speech earns verified mastery.
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    await act(async () => {
      setNativeInputValue(textarea, GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT);
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: false,
      epistemicStatus: "rubric_verified_evidence",
      masteryQualified: true,
      countsTowardMastery: true,
    });
  });

  it("initializes Speaking checkbox cleanly when sticky assistance starts active with mismatched duration props", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const seed = fixture.speakingSeed;
    const assistedReceipt = evaluateSpeakingRetelling({
      seed,
      transcript: fixture.initialSpeakingTranscript,
      durationSeconds: fixture.initialSpeakingDurationSeconds,
      assisted: true,
    });
    await act(async () => root.render(createElement(IeltsSpeakingTransferCard, {
      seed,
      initialTranscript: fixture.initialSpeakingTranscript,
      initialDurationSeconds: 72,
      initialReceipt: assistedReceipt,
    })));

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);

    // Partial edits cannot clear latched assistance; only explicit full reset starts a fresh unassisted attempt.
    await act(async () => setNativeInputValue(
      textarea,
      `${fixture.initialSpeakingTranscript} Better evening timetables also help outer-suburban commuters.`,
    ));
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(textarea.value).toBe("");
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
  });

  it("tracks post-submit argumentBridgeCues and quote rewrites on custom seeds without a sampleTranscript across edits and resets", async () => {
    const fixture = IELTS_WRITING_SPEAKING_FIXTURE;
    const customSeed = {
      ...buildSpeakingPart3Seed(
        {
          promptId: fixture.promptId,
          topic: "urban public transport funding",
          coreClaim:
            "Municipal councils should prioritise electrified urban rail networks over continual motorway expansion for sustainable commuter capacity.",
          supportingReason:
            "High-capacity trains alleviate chronic congestion and reduce per-capita emissions without carving extra highway lanes through residential blocks.",
          counterPerspective:
            "Admittedly, distant suburban households still rely on feeder buses to connect comfortably with major transit corridors.",
          activeCollocations: fixture.coreArgument.activeCollocations,
        },
        fixture.draft2.draftId,
      ),
      seedId: "custom-post-submit-cue-seed",
      requiresVerifiedReceipt: true,
      verifiedWritingReceipt: fixture.draft2Receipt,
    };

    const onEvaluated = vi.fn();
    await act(async () =>
      root.render(
        createElement(IeltsSpeakingTransferCard, {
          seed: customSeed,
          onEvaluated,
        }),
      ),
    );

    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="口语复述记录输入框"]')!;
    const durationInput = host.querySelector<HTMLInputElement>('[aria-label="口语作答时长秒数"]')!;
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const evaluateBtn = () => host.querySelector<HTMLButtonElement>("[data-speaking-evaluate]")!;

    // Before first submission, cues are hidden and no sampleTranscript exists.
    expect(host.textContent).not.toContain(customSeed.argumentBridgeCues[0]!);
    expect(host.querySelector("[data-speaking-sample-transcript]")).toBeNull();

    // Attempt #1: submit short non-empty speech WITHOUT clicking [data-reveal-scaffold].
    await act(async () => {
      setNativeInputValue(
        textarea,
        "I think city planners need reliable public trains to keep rush-hour commuting dependable.",
      );
      setNativeInputValue(durationInput, "25");
    });
    await act(async () => evaluateBtn().click());
    const firstReceipt = onEvaluated.mock.lastCall?.[0];
    expect(firstReceipt).toMatchObject({
      assisted: false,
      paceStatus: "too_short",
      epistemicStatus: "practice_feedback",
    });
    // Cues and quote upgradeRewrite are now visible on screen after submit #1!
    expect(host.textContent).toContain(customSeed.argumentBridgeCues[0]!);
    const displayedQuoteRewrite = firstReceipt?.evidenceQuotes[0]?.upgradeRewrite;
    expect(displayedQuoteRewrite).toContain("Personally, I think the core tension");

    // Path A: Directly editing after submit #1 (without reset) to paste a displayed cue locks assistance.
    const cueSentence =
      "Municipal councils should prioritise electrified urban rail networks over continual motorway expansion for sustainable commuter capacity.";
    await act(async () => {
      setNativeInputValue(
        textarea,
        `${cueSentence} Voters often focus on immediate road repaving before elections rather than multi-year underground rail construction across busy urban neighbourhoods.`,
      );
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Path B: Reset -> paste a displayed argumentBridgeCue -> MUST lock assistance and block mastery!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(textarea.value).toBe("");
    expect(durationInput.value).toBe("");
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);

    await act(async () => {
      setNativeInputValue(
        textarea,
        "High-capacity trains alleviate chronic congestion and reduce per-capita emissions without carving extra highway lanes through residential blocks. " +
          "Regional ministries also have to coordinate shuttle routes so outer commuters can reach platforms smoothly during busy weekday evenings.",
      );
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Path C: Reset -> paste the post-submit evidenceQuote upgradeRewrite -> MUST also lock assistance!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    await act(async () => {
      setNativeInputValue(
        textarea,
        `${displayedQuoteRewrite} Local authorities must balance immediate commuter convenience against multi-decade fiscal resilience for growing metropolitan districts.`,
      );
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: true,
      epistemicStatus: "practice_feedback",
      masteryQualified: false,
      countsTowardMastery: false,
    });

    // Path D: Reset -> submit genuinely fresh original 76s response -> earns rubric_verified_evidence!
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reset-attempt]")!.click());
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    await act(async () => {
      setNativeInputValue(textarea, GENUINE_ORIGINAL_SPEAKING_TRANSCRIPT);
      setNativeInputValue(durationInput, "76");
    });
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    await act(async () => evaluateBtn().click());
    expect(onEvaluated.mock.lastCall?.[0]).toMatchObject({
      assisted: false,
      epistemicStatus: "rubric_verified_evidence",
      masteryQualified: true,
      countsTowardMastery: true,
    });
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
