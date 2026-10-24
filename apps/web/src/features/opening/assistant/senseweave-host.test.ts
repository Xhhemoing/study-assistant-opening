import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { MessageList } from "./message-list";
import type { ChatMessageView } from "./message-model";
import { prepareSenseWeave, senseWeavePreset } from "./senseweave-host";

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
