import { describe, expect, it } from "vitest";
import type { ThinTutorActionView } from "../client/api";
import {
  INDEPENDENT_VARIANT_NOTICE,
  TUTOR_ACTION_KIND_LABEL,
  independentVariantPrompt,
  tutorActionIntent,
} from "./tutor-action-intents";

function action(kind: ThinTutorActionView["kind"], overrides: Partial<ThinTutorActionView> = {}): ThinTutorActionView {
  return {
    kind,
    skillLabel: "chain rule",
    currentPage: 2,
    nodeId: null,
    problemRef: null,
    reason: "reason text",
    evidenceIds: [],
    ...overrides,
  };
}

describe("tutor action chip intents", () => {
  it("labels every defined kind without mastery wording", () => {
    const kinds = ["clarify", "guided", "worked_example", "independent_variant", "delayed_retest"] as const;
    for (const kind of kinds) {
      expect(TUTOR_ACTION_KIND_LABEL[kind]).toBeTruthy();
      expect(TUTOR_ACTION_KIND_LABEL[kind]).not.toMatch(/掌握|mastery|%/);
    }
  });

  it("maps guided and worked_example onto existing tutor modes without writes", () => {
    expect(tutorActionIntent(action("guided"))).toMatchObject({ kind: "guided", mode: "hint" });
    expect(tutorActionIntent(action("worked_example"))).toMatchObject({ kind: "worked_example", mode: "explain" });
  });

  it("prefills the independent variant draft with the no-hint request", () => {
    const intent = tutorActionIntent(action("independent_variant", { problemRef: "p1:variant" }));
    expect(intent.kind).toBe("independent_variant");
    if (intent.kind !== "independent_variant") return;
    expect(intent.draft).toContain("chain rule");
    expect(intent.draft).toContain("p1:variant");
    expect(intent.draft).toContain(INDEPENDENT_VARIANT_NOTICE);
    expect(intent.draft).toContain("不要先给提示");
  });

  it("keeps clarify and delayed_retest as pure navigation intents", () => {
    expect(tutorActionIntent(action("clarify"))).toEqual({ kind: "clarify", action: action("clarify") });
    expect(tutorActionIntent(action("delayed_retest"))).toEqual({
      kind: "delayed_retest",
      action: action("delayed_retest"),
    });
  });

  it("mentions the skill topic even when problemRef is absent", () => {
    const prompt = independentVariantPrompt(action("independent_variant", { problemRef: null }));
    expect(prompt).toContain("chain rule");
    expect(prompt).not.toContain("参考原题");
  });
});
