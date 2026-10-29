import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { MessageList } from "./message-list";
import type { ChatMessageView } from "./message-model";
import { prepareSenseWeave, senseWeaveAdapter, senseWeaveComponents, senseWeavePreset, senseWeaveSketch } from "./senseweave-host";

const diagramAnswer = [
  "做这类题可以按固定流程来：先画受力图，再根据牛顿第二定律求加速度，最后选择不含未知量的运动学公式代入并检查单位 [1]。",
  "",
  "```mermaid",
  "flowchart TD",
  "A[受力分析] --> B[求加速度] --> C[选公式] --> D[代入检验]",
  "```",
  "",
  "注意：减速到零之后物体不会反向运动。",
].join("\n");

function message(id: string, role: "user" | "assistant", text: string, status?: ChatMessageView["status"]): ChatMessageView {
  return { id, role, text, citations: [], citationLabels: [], ...(status ? { status } : {}) };
}

describe("SenseWeave host (SW0)", () => {
  it("maps learner questions to conservative presets", () => {
    expect(senseWeavePreset("给我一点提示，别直接告诉答案")).toBe("hint");
    expect(senseWeavePreset("这道题我哪里错了")).toBe("review");
    expect(senseWeavePreset("帮我做个一周复习计划")).toBe("plan");
    expect(senseWeavePreset("最近几次的正确率怎么样")).toBe("data");
    expect(senseWeavePreset("速度和速率有什么区别")).toBe("compare");
    expect(senseWeavePreset("这个公式怎么推导")).toBe("derive");
    expect(senseWeavePreset("讲讲匀变速运动")).toBe("explain");
    expect(senseWeavePreset(undefined)).toBe("explain");
  });

  it("actual vendored entry keeps HTML, nested lists and encoded Mermaid labels as text", () => {
    const prefix = "保真回归。".repeat(30);
    const cases = [
      { text: `<pre>\n${prefix}\n\n| name | time (ms) |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| C | 3 |\n\n</pre>`, prompt: "比较区别" },
      { text: `${prefix}\n\n- - 第一项\n- - 第二项\n- - 第三项`, prompt: "制定计划" },
      { text: `${prefix}\n\n- - -\n- - -\n- - -`, prompt: "制定计划" },
      { text: `${prefix}\n\n\`\`\`mermaid\nflowchart TD\nA["#9829;"] --> B[结束]\n\`\`\``, prompt: "讲解" },
    ];
    for (const [index, item] of cases.entries()) {
      const output = prepareSenseWeave({ id: `regression-${index}`, text: item.text }, item.prompt);
      expect(output.enhanced).toBe(false);
      expect(output.segments.map(segment => segment.source).join("")).toBe(item.text);
    }
  });

  it("splits a finished answer losslessly and keeps short or hint answers as text", () => {
    const prepared = prepareSenseWeave({ id: "t1", text: diagramAnswer }, "讲讲解题流程");
    expect(prepared.segments.map(segment => segment.source).join("")).toBe(diagramAnswer);
    expect(prepared.segments.filter(segment => segment.kind === "block").map(segment => segment.kind === "block" && segment.type)).toEqual(["diagram"]);
    expect(prepared.extraModelCalls).toBe(0);
    expect(prepareSenseWeave({ id: "t2", text: "$F=ma$，所以 $a=2$。" }, "讲讲").enhanced).toBe(false);
    expect(prepareSenseWeave({ id: "t3", text: diagramAnswer }, "给我一点提示").enhanced).toBe(false);
  });
});

const lead = "请先通读题目，标出已知量、未知量和隐含条件，再决定使用哪个公式。这一题的思路是先把已知条件整理清楚，再逐步代入，每一步都检查单位和符号，避免把中间量弄混。下面是完整的推导过程，请逐行核对。";
const derivationAnswer = `${lead}先写出 a=1。再代入得到 b=a+1=2。最后得到 c=b+1=3。`;
const sentence = "四次测验的成绩：第一次 60 分，第二次 70 分，第三次 80 分，第四次 90 分。";
const chartAnswer = `${lead}${sentence}整体是稳步上升的。`;

describe("SenseWeave vendor update (placement, derivation, sketch, no AI)", () => {
  it("board derivation joins explain/derive only; hint, review, plan and data never get it", () => {
    expect(senseWeaveComponents("explain", CLOSED_CAPABILITIES.senseWeaveGates)).toContain("derivation");
    expect(senseWeaveComponents("derive", CLOSED_CAPABILITIES.senseWeaveGates)).toContain("derivation");
    for (const preset of ["hint", "review", "plan", "data", "compare"] as const) expect(senseWeaveComponents(preset, CLOSED_CAPABILITIES.senseWeaveGates)).not.toContain("derivation");
    const explained = prepareSenseWeave({ id: "d1", text: derivationAnswer, mode: "explain" }, "讲讲这道题");
    expect(explained.segments.filter(segment => segment.kind === "block").map(segment => segment.kind === "block" && segment.type)).toEqual(["derivation"]);
    expect(explained.segments.map(segment => segment.source).join("")).toBe(derivationAnswer);
    expect(prepareSenseWeave({ id: "d2", text: derivationAnswer, mode: "hint" }, "讲讲这道题").enhanced).toBe(false);
    expect(prepareSenseWeave({ id: "d3", text: derivationAnswer }, "给我一点提示，别直接告诉答案").enhanced).toBe(false);
    const gated = structuredClone(CLOSED_CAPABILITIES.senseWeaveGates);
    gated.presets.explain = gated.presets.explain.filter(type => type !== "derivation");
    const withoutDerivation = prepareSenseWeave({ id: "d4", text: derivationAnswer, mode: "explain" }, "讲讲这道题", gated);
    expect(withoutDerivation.segments.some(segment => segment.kind === "block" && segment.type === "derivation")).toBe(false);
  });

  it("supplementary views replace their verbatim sentence; segments stay lossless", () => {
    const prepared = prepareSenseWeave({ id: "c1", text: chartAnswer }, "最近几次成绩的趋势");
    const block = prepared.segments.find(segment => segment.kind === "block");
    expect(block?.kind === "block" && block.type).toBe("chart");
    expect(block?.kind === "block" && block.placement).toBe("replace");
    expect(block?.source).toBe(sentence);
    expect(block?.kind === "block" && block.original).toBe(sentence);
    expect(prepared.segments.map(segment => segment.source).join("")).toBe(chartAnswer);
    expect(prepared.segments.filter(segment => segment.kind === "text").map(segment => segment.source).join("")).not.toContain("第一次 60 分");
  });

  it("sketch only for explain/review and switchable by the gate table; motion stays default; no AI calls", () => {
    const gates = CLOSED_CAPABILITIES.senseWeaveGates;
    expect(senseWeaveSketch("explain", gates)).toBe(true);
    expect(senseWeaveSketch("review", gates)).toBe(true);
    for (const preset of ["hint", "derive", "compare", "plan", "data"] as const) expect(senseWeaveSketch(preset, gates)).toBe(false);
    expect(senseWeaveSketch("explain", { ...gates, sketch: false })).toBe(false);
    const explained = prepareSenseWeave({ id: "s1", text: derivationAnswer, mode: "explain" }, "讲讲这道题");
    expect(explained.decision?.presentation?.sketch).toBe(true);
    expect(Object.values(explained.decision?.presentation?.motion ?? {})).toContain("write");
    const derived = prepareSenseWeave({ id: "s2", text: derivationAnswer }, "这个公式怎么推导");
    expect(derived.preset).toBe("derive");
    expect(derived.decision?.presentation?.sketch).toBe(false);
    const off = prepareSenseWeave({ id: "s3", text: derivationAnswer, mode: "explain" }, "讲讲这道题", { ...gates, sketch: false });
    expect(off.decision?.presentation?.sketch).toBe(false);
    for (const prepared of [explained, derived, off]) expect(prepared.extraModelCalls).toBe(0);
    expect(senseWeaveAdapter("explain", gates).stats().extraModelCalls).toBe(0);
  });
});

describe("MessageList with chatSenseWeave", () => {
  const messages = [message("u1", "user", "讲讲这类题的解题流程"), message("a1", "assistant", diagramAnswer, "complete")];
  const render = (chatSenseWeave: "off" | "shadow" | "on", chatArtifacts = false) => renderToStaticMarkup(createElement(
    OpeningCapabilitiesContext.Provider,
    { value: { ...CLOSED_CAPABILITIES, chatProse: true, chatArtifacts, chatSenseWeave } },
    createElement(MessageList, { messages }),
  ));

  it("shadow and off render the answer exactly as LearningProse alone", () => {
    const off = render("off");
    expect(render("shadow")).toBe(off);
    expect(off).not.toContain("data-senseweave-block");
  });

  it("shadow keeps the UI unchanged even when placement would replace a sentence", () => {
    const chart = [message("u2", "user", "最近几次成绩的趋势"), message("a2", "assistant", chartAnswer, "complete")];
    const view = (chatSenseWeave: "off" | "shadow" | "on") => renderToStaticMarkup(createElement(OpeningCapabilitiesContext.Provider,
      { value: { ...CLOSED_CAPABILITIES, chatProse: true, chatSenseWeave } }, createElement(MessageList, { messages: chart })));
    const off = view("off");
    expect(view("shadow")).toBe(off);
    expect(off).toContain("第一次 60 分");
    const on = view("on");
    expect(on).toContain('data-senseweave-block="chart"');
    expect(on).not.toContain("第一次 60 分");
  });

  it("on renders the selected fragment as a block between text that keeps answer offsets", () => {
    const html = render("on");
    expect(html).toContain('data-senseweave-block="diagram"');
    expect(html).toContain("改回文字");
    const start = diagramAnswer.indexOf("```mermaid");
    expect(html).toContain(`data-src-start="${start}"`);
    expect(html).toContain("注意：减速到零之后物体不会反向运动。");
    expect(html).not.toContain("flowchart TD");
  });

  it("an enhanced answer does not also get the rules-planner 图解", () => {
    expect(render("on", true)).not.toContain("data-message-artifact");
  });

  it("trusted hint mode and host gating keep enhanced components out of the real message renderer", () => {
    for (const override of [{ mode: "hint" as const }, {}]) {
      const gates = structuredClone(CLOSED_CAPABILITIES.senseWeaveGates);
      if (!override.mode) gates.presets.explain = ["prose"];
      const html = renderToStaticMarkup(createElement(OpeningCapabilitiesContext.Provider,
        { value: { ...CLOSED_CAPABILITIES, chatProse: true, chatSenseWeave: "on", senseWeaveGates: gates } },
        createElement(MessageList, { messages: [messages[0]!, { ...messages[1]!, ...override }] }),
      ));
      expect(html).not.toContain("data-senseweave-block");
      expect(html).toContain("flowchart TD");
    }
  });

  it("streaming answers are never split", () => {
    const pending = [messages[0]!, message("a1", "assistant", diagramAnswer, "pending")];
    const html = renderToStaticMarkup(createElement(
      OpeningCapabilitiesContext.Provider,
      { value: { ...CLOSED_CAPABILITIES, chatProse: true, chatSenseWeave: "on" } },
      createElement(MessageList, { messages: pending }),
    ));
    expect(html).not.toContain("data-senseweave-block");
  });
});
