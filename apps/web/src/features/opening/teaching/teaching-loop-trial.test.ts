import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  isOpeningTeachingLoopTrialEnabled,
  resolveTeachingLoopTrialGate,
} from "./teaching-loop-trial";
import { TeachingLoopTrialEmpty } from "./teaching-loop-trial-empty";

describe("isOpeningTeachingLoopTrialEnabled / resolveTeachingLoopTrialGate", () => {
  it("both on → trialEnabled true (entry)", () => {
    const gate = resolveTeachingLoopTrialGate({
      OPENING_TEACHING_LOOP: "1",
      OPENING_TEACHING_WORKSPACE: "1",
    });
    expect(gate).toEqual({
      loopEnabled: true,
      workspaceEnabled: true,
      trialEnabled: true,
    });
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_LOOP: "true",
        OPENING_TEACHING_WORKSPACE: "yes",
      }),
    ).toBe(true);
  });

  it("loop off / workspace on → empty honesty (trialEnabled false)", () => {
    const gate = resolveTeachingLoopTrialGate({
      OPENING_TEACHING_LOOP: "0",
      OPENING_TEACHING_WORKSPACE: "1",
    });
    expect(gate.loopEnabled).toBe(false);
    expect(gate.workspaceEnabled).toBe(true);
    expect(gate.trialEnabled).toBe(false);
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_WORKSPACE: "1",
      }),
    ).toBe(false);
  });

  it("loop on / workspace off → empty honesty (trialEnabled false)", () => {
    const gate = resolveTeachingLoopTrialGate({
      OPENING_TEACHING_LOOP: "1",
      OPENING_TEACHING_WORKSPACE: "0",
    });
    expect(gate.loopEnabled).toBe(true);
    expect(gate.workspaceEnabled).toBe(false);
    expect(gate.trialEnabled).toBe(false);
    expect(
      isOpeningTeachingLoopTrialEnabled({
        OPENING_TEACHING_LOOP: "1",
      }),
    ).toBe(false);
  });

  it("both off → empty honesty (trialEnabled false)", () => {
    const gate = resolveTeachingLoopTrialGate({});
    expect(gate).toEqual({
      loopEnabled: false,
      workspaceEnabled: false,
      trialEnabled: false,
    });
    expect(isOpeningTeachingLoopTrialEnabled({})).toBe(false);
  });

  it("composes existing helpers (NEXT_PUBLIC_* also works; no third parser)", () => {
    expect(
      isOpeningTeachingLoopTrialEnabled({
        NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1",
        NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE: "1",
      }),
    ).toBe(true);
    expect(
      isOpeningTeachingLoopTrialEnabled({
        NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1",
        NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE: "0",
      }),
    ).toBe(false);
  });
});

describe("TeachingLoopTrialEmpty (honest empty UI)", () => {
  it("states that trial needs both flags and demotes free chat", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingLoopTrialEmpty, {
        assistantHref: "/opening/assistant?conversation=demo",
        loopEnabled: false,
        workspaceEnabled: true,
      }),
    );
    expect(html).toContain('data-teaching-loop-trial-empty="true"');
    expect(html).toContain("AI 主讲试运行未开启");
    expect(html).toContain("OPENING_TEACHING_LOOP");
    expect(html).toContain("OPENING_TEACHING_WORKSPACE");
    expect(html).toContain("缺少");
    expect(html).toContain("OPENING_TEACHING_LOOP");
    expect(html).toContain("不会进入主讲工作台");
    expect(html).toContain("也不会把自由对话当成主讲试运行");
    expect(html).toContain("打开自由对话（次要）");
    expect(html).toContain("/opening/assistant?conversation=demo");
    expect(html).not.toContain("data-teaching-workspace");
    expect(html).not.toContain("data-today-primary-cta");
  });

  it("lists both missing flags when both off", () => {
    const html = renderToStaticMarkup(
      createElement(TeachingLoopTrialEmpty, {
        loopEnabled: false,
        workspaceEnabled: false,
      }),
    );
    expect(html).toContain("OPENING_TEACHING_LOOP、OPENING_TEACHING_WORKSPACE");
    expect(html).toContain('data-loop-enabled="false"');
    expect(html).toContain('data-workspace-enabled="false"');
  });
});
