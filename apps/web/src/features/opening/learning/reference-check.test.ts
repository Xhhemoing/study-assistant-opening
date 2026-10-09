import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { OpeningApiError } from "../client/api";
import {
  buildSelfCompareMethod,
  buildSelfCompareRevision,
  isAssistanceAllowed,
  preselectAssistance,
  raiseAssistanceOnly,
  referenceCheckFailure,
  selfCompareRevisionIntentKey,
  SELF_COMPARE_REASON,
} from "./reference-check";
import { ReferenceCheckStep } from "./reference-check-step";

const SOURCE = "77777777-7777-4777-8777-777777777777";
const observation = {
  ...learningObservation,
  answer: "原始答案不得改动",
  outcome: "unverified" as const,
  verdictSource: "self_report" as const,
  assistance: "independent" as const,
};

describe("buildSelfCompareRevision", () => {
  it("locks the original answer into a reference_checked whole_answer match", () => {
    const command = buildSelfCompareRevision({
      observation,
      referenceSourceId: SOURCE,
      choice: "match",
      page: 3,
      clientKey: "self-compare-key-01",
    });
    expect(command).toMatchObject({
      revisionKind: "replace",
      reason: SELF_COMPARE_REASON,
      clientKey: "self-compare-key-01",
      expectedHead: observation.id,
      replacement: {
        answer: "原始答案不得改动",
        outcome: "correct",
        assistance: "independent",
        verdictSource: "reference_checked",
        referenceSourceId: SOURCE,
        referenceCheck: {
          referenceSourceId: SOURCE,
          method: "learner_self_compare 第3页",
          scope: "whole_answer",
        },
      },
    });
  });

  it("records mismatch as incorrect whole_answer and partial as unverified partial scope", () => {
    expect(
      buildSelfCompareRevision({
        observation,
        referenceSourceId: SOURCE,
        choice: "mismatch",
        clientKey: "k-mismatch",
      })?.replacement,
    ).toMatchObject({
      answer: observation.answer,
      outcome: "incorrect",
      referenceCheck: { scope: "whole_answer", method: "learner_self_compare" },
    });
    expect(
      buildSelfCompareRevision({
        observation,
        referenceSourceId: SOURCE,
        choice: "partial",
        clientKey: "k-partial",
      })?.replacement,
    ).toMatchObject({
      answer: observation.answer,
      outcome: "unverified",
      referenceCheck: { scope: "partial" },
    });
  });

  it("does not build a request when the learner cannot understand the reference", () => {
    expect(
      buildSelfCompareRevision({
        observation,
        referenceSourceId: SOURCE,
        choice: "unclear",
        clientKey: "k-unclear",
      }),
    ).toBeNull();
  });

  it("reuses the same clientKey for the same intent fingerprint", () => {
    const a = selfCompareRevisionIntentKey(observation.id, "match", 3);
    const b = selfCompareRevisionIntentKey(observation.id, "match", 3);
    const c = selfCompareRevisionIntentKey(observation.id, "mismatch", 3);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("builds method with optional page suffix", () => {
    expect(buildSelfCompareMethod()).toBe("learner_self_compare");
    expect(buildSelfCompareMethod(null)).toBe("learner_self_compare");
    expect(buildSelfCompareMethod(1)).toBe("learner_self_compare 第1页");
  });
});

describe("delivered assistance floor", () => {
  it("preselects delivered level and only allows raising", () => {
    expect(preselectAssistance("none")).toBe("unknown");
    expect(preselectAssistance("hinted")).toBe("hinted");
    expect(preselectAssistance("revealed")).toBe("revealed");
    expect(isAssistanceAllowed("independent", "hinted")).toBe(false);
    expect(isAssistanceAllowed("hinted", "hinted")).toBe(true);
    expect(isAssistanceAllowed("revealed", "hinted")).toBe(true);
    expect(isAssistanceAllowed("independent", "revealed")).toBe(false);
    expect(raiseAssistanceOnly("independent", "hinted")).toBe("hinted");
    expect(raiseAssistanceOnly("revealed", "hinted")).toBe("revealed");
    expect(raiseAssistanceOnly("unknown", "none")).toBe("unknown");
  });

  it("maps 409 to a re-read prompt", () => {
    expect(referenceCheckFailure(new OpeningApiError(409, "head changed", "CONFLICT"))).toEqual({
      kind: "conflict",
      message: "记录已被更新。请重新读取后再对照参考核对。",
    });
  });
});

describe("ReferenceCheckStep", () => {
  it("locks the answer and labels the step as self-compare", () => {
    const html = renderToStaticMarkup(
      createElement(ReferenceCheckStep, {
        observation,
        referenceSourceId: SOURCE,
        referenceSourceName: "答案页.pdf",
        onChecked: () => undefined,
        onSkip: () => undefined,
      }),
    );
    expect(html).toContain("自对照参考");
    expect(html).toContain("原始答案不得改动");
    expect(html).toContain("readOnly");
    expect(html).toContain("全部一致");
    expect(html).toContain("看不懂参考");
    expect(html).toContain("答案页.pdf");
  });
});
