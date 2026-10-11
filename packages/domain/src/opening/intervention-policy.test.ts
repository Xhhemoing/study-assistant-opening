import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_PROACTIVE_REJECT_LIMIT,
  DEFAULT_OPENING_INTERVENTION_PREFS,
  type InterventionPrefs,
} from "@aistudy/contracts";
import * as policyModule from "./intervention-policy";
import {
  appendInterventionDecision,
  countConsecutiveProactiveRejects,
  decideIntervention,
  gateTutorRecommendAfterDecision,
  mayAutoRespondProactive,
  mergeSessionInterventionPrefs,
  resolveInterventionPrefs,
} from "./intervention-policy";

const base = DEFAULT_OPENING_INTERVENTION_PREFS;

function ctx(
  patch: Partial<Parameters<typeof decideIntervention>[0]["context"]> = {},
): Parameters<typeof decideIntervention>[0]["context"] {
  return {
    userIsTyping: false,
    consecutiveProactiveRejects: 0,
    evidenceStrength: "ok",
    nodeKind: "prompt",
    sessionExposures: [],
    proposedKind: "guided",
    userRequestedDepth: null,
    ...patch,
  };
}

describe("resolveInterventionPrefs (T2)", () => {
  it("applies session > course > global; missing keys inherit; does not mutate global", () => {
    const global: InterventionPrefs = {
      ...base,
      quietMode: false,
      proactivity: "balanced",
      nodes: { ...base.nodes, allowOnLowEvidence: false },
    };
    const frozen = structuredClone(global);
    const effective = resolveInterventionPrefs(
      global,
      { quietMode: true, nodes: { allowOnTeach: false } },
      { proactivity: "minimal" },
    );
    expect(effective).toEqual({
      proactivity: "minimal",
      quietMode: true,
      depth: "hint_then_offer",
      nodes: {
        allowOnTeach: false,
        allowOnPrompt: true,
        allowOnLowEvidence: false,
      },
    });
    expect(global).toEqual(frozen);
    expect(effective).not.toBe(global);
  });
});

describe("decideIntervention decision table", () => {
  it("T3: quiet / off + user_help_ask → respond", () => {
    for (const prefs of [
      { ...base, quietMode: true },
      { ...base, proactivity: "off" as const },
    ]) {
      const r = decideIntervention({
        prefs,
        trigger: "user_help_ask",
        context: ctx(),
      });
      expect(r.decision).toBe("respond");
      expect(r.reason).toBe("user_request");
    }
  });

  it("T4: quiet / off + system_proactive → none", () => {
    expect(
      decideIntervention({
        prefs: { ...base, quietMode: true },
        trigger: "system_proactive",
        context: ctx(),
      }),
    ).toMatchObject({ decision: "none", reason: "quiet_mode" });
    expect(
      decideIntervention({
        prefs: { ...base, proactivity: "off" },
        trigger: "tutor_recommend",
        context: ctx(),
      }),
    ).toMatchObject({ decision: "none", reason: "proactivity_off" });
  });

  it("T5: userIsTyping + proactive → none (user_typing)", () => {
    const r = decideIntervention({
      prefs: base,
      trigger: "system_proactive",
      context: ctx({ userIsTyping: true }),
    });
    expect(r.decision).toBe("none");
    expect(r.reason).toBe("user_typing");
  });

  it("T6: consecutiveProactiveRejects >= 2 → none; counter from ring helper", () => {
    const ring = [
      {
        trigger: "system_proactive" as const,
        decision: "none" as const,
      },
      {
        trigger: "tutor_recommend" as const,
        decision: "defer" as const,
      },
    ];
    expect(countConsecutiveProactiveRejects(ring)).toBe(2);
    expect(CONSECUTIVE_PROACTIVE_REJECT_LIMIT).toBe(2);
    const r = decideIntervention({
      prefs: base,
      trigger: "system_proactive",
      context: ctx({ consecutiveProactiveRejects: 2 }),
    });
    expect(r).toMatchObject({ decision: "none", reason: "consecutive_reject" });
  });

  it("T7: low evidence + allowOnLowEvidence false → defer", () => {
    const r = decideIntervention({
      prefs: base,
      trigger: "system_proactive",
      context: ctx({ evidenceStrength: "low" }),
    });
    expect(r).toMatchObject({ decision: "defer", reason: "low_evidence" });
  });

  it("T8: hinted + worked_example → offer, never respond", () => {
    const r = decideIntervention({
      prefs: base,
      trigger: "tutor_recommend",
      context: ctx({
        sessionExposures: ["hinted"],
        proposedKind: "worked_example",
      }),
    });
    expect(r.decision).toBe("offer");
    expect(r.decision).not.toBe("respond");
    expect(r.reason).toBe("depth_blocks_auto_expand");
  });

  it("T9: explicit ask explain → respond even if hinted", () => {
    const r = decideIntervention({
      prefs: { ...base, quietMode: true },
      trigger: "user_help_ask",
      context: ctx({
        sessionExposures: ["hinted"],
        userRequestedDepth: "explain",
        proposedKind: "worked_example",
      }),
    });
    expect(r.decision).toBe("respond");
    expect(r.reason).toBe("user_request");
  });

  it("T10: no hardcoded interval / dwell exports", () => {
    const keys = Object.keys(policyModule);
    expect(keys).not.toContain("N_MINUTES");
    expect(keys).not.toContain("mustAskEvery");
    expect(keys).not.toContain("dwellStuck");
    expect(keys).not.toContain("intervalMinutes");
    expect("N_MINUTES" in policyModule).toBe(false);
  });
});

describe("checkpoint session overlay (T12)", () => {
  it("session merge does not mutate durable prefs object and preserves drafts", () => {
    const durable = { ...base };
    const checkpoint = { drafts: [{ blockId: "b1" }], anchors: { x: 1 } };
    const next = mergeSessionInterventionPrefs(checkpoint, {
      quietMode: true,
    });
    expect(next.interventionPrefs).toEqual({ quietMode: true });
    expect(next.drafts).toEqual([{ blockId: "b1" }]);
    expect(next.anchors).toEqual({ x: 1 });
    expect(durable).toEqual(base);
    expect(checkpoint).not.toHaveProperty("interventionPrefs");

    const cleared = mergeSessionInterventionPrefs(next, null);
    expect(cleared).not.toHaveProperty("interventionPrefs");
    expect(cleared.drafts).toEqual([{ blockId: "b1" }]);
  });

  it("decision ring append caps at 20 and preserves drafts", () => {
    let cp: Record<string, unknown> = { drafts: [] };
    for (let i = 0; i < 25; i++) {
      cp = appendInterventionDecision(cp, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        at: "2026-10-11T04:00:00.000Z",
        activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        trigger: "system_proactive",
        decision: "none",
        reason: "quiet_mode",
      });
    }
    expect((cp.interventionDecisions as unknown[]).length).toBe(20);
    expect(cp.drafts).toEqual([]);
  });
});

describe("gate escalate-after-hint (T14)", () => {
  it("recommend escalate cannot auto-respond after hint; offer ok", () => {
    const decision = decideIntervention({
      prefs: base,
      trigger: "tutor_recommend",
      context: ctx({
        sessionExposures: ["hinted"],
        proposedKind: "worked_example",
      }),
    });
    const gated = gateTutorRecommendAfterDecision("worked_example", decision);
    expect(gated.allowAutoRespond).toBe(false);
    expect(gated.allowOffer).toBe(true);
    expect(mayAutoRespondProactive(decision)).toBe(false);
    expect(decision.decision).toBe("offer");
    expect(decision.decision).not.toBe("respond");
  });
});

describe("node_disallowed / minimal", () => {
  it("disallowed teach node → none", () => {
    expect(
      decideIntervention({
        prefs: {
          ...base,
          nodes: { ...base.nodes, allowOnTeach: false },
        },
        trigger: "system_proactive",
        context: ctx({ nodeKind: "teach" }),
      }),
    ).toMatchObject({ decision: "none", reason: "node_disallowed" });
  });

  it("minimal prefers offer", () => {
    expect(
      decideIntervention({
        prefs: { ...base, proactivity: "minimal" },
        trigger: "system_proactive",
        context: ctx({ proposedKind: "guided" }),
      }),
    ).toMatchObject({ decision: "offer", reason: "proactivity_minimal" });
  });
});
