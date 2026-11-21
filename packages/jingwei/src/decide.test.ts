import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Artifact, ArtifactBlock } from "./artifact";
import { CapabilityRegistrationError, createCapabilityRegistry, defineCapability, type Capability } from "./capability";
import { artifactToText, decideArtifact, decideBlock } from "./decide";
import { findUnsafeContent, isUnsafeUrl } from "./sanitize";
import { resolveDisplayMode } from "./view";

const comparisonBars = defineCapability({
  id: "comparison-bars@1",
  title: "数据比较",
  tasks: ["compare"],
  modes: ["text", "static", "interactive"],
  params: z
    .object({
      unit: z.string().max(20).optional(),
      bars: z.array(z.object({ label: z.string().min(1).max(24), value: z.number().finite().min(0) }).strict()).min(2).max(8),
    })
    .strict(),
  limits: ["只描述输入数值，不推断因果"],
  actions: ["local.sort"],
  toText: ({ bars, unit }) => bars.map((bar) => `${bar.label}：${bar.value}${unit ?? ""}`).join("；"),
});

const prose = defineCapability({
  id: "prose@1",
  title: "文字",
  tasks: ["define"],
  modes: ["text"],
  params: z.object({ text: z.string().min(1).max(4000) }).strict(),
  limits: [],
  toText: ({ text }) => text,
});

const registry = createCapabilityRegistry([comparisonBars, prose]);

function block(overrides: Partial<ArtifactBlock>): ArtifactBlock {
  return {
    id: "b1",
    capability: "comparison-bars@1",
    params: { unit: "分钟", bars: [{ label: "阅读", value: 25 }, { label: "练习", value: 40 }] },
    allowedActions: [],
    limits: [],
    sourceRefs: [],
    ...overrides,
  };
}

describe("createCapabilityRegistry", () => {
  it("rejects malformed catalogs at registration time", () => {
    const base = prose as Capability;
    expect(() => createCapabilityRegistry([base, base])).toThrow(CapabilityRegistrationError);
    expect(() => createCapabilityRegistry([{ ...base, id: "prose" }])).toThrow(/name@major/);
    expect(() => createCapabilityRegistry([{ ...base, modes: ["static"] }])).toThrow(/text mode/);
    expect(() => createCapabilityRegistry([{ ...base, tasks: [] }])).toThrow(/task/);
  });

  it("describes the catalog as JSON-serializable schemas for planners and other agents", () => {
    const [bars] = registry.describe();
    expect(bars).toMatchObject({ id: "comparison-bars@1", tasks: ["compare"], actions: ["local.sort"] });
    expect(bars!.paramsSchema).toMatchObject({ type: "object", required: ["bars"] });
    expect(() => JSON.stringify(registry.describe())).not.toThrow();
  });
});

describe("decideBlock", () => {
  it("parses params, picks a mode and always provides text", () => {
    const decision = decideBlock(block({}), registry);
    expect(decision).toMatchObject({ ok: true, mode: "interactive", text: "阅读：25分钟；练习：40分钟" });
  });

  it("fails soft on unknown capabilities and invalid params", () => {
    expect(decideBlock(block({ capability: "iframe@1" }), registry)).toMatchObject({ ok: false, reason: "unknown_capability" });
    // No data → no invented bars.
    expect(decideBlock(block({ params: { bars: [] } }), registry)).toMatchObject({ ok: false, reason: "invalid_params" });
  });

  it("rejects unsafe shapes anywhere in params before schema parsing", () => {
    const nestedLink = { bars: [{ label: "a", value: 1, meta: { href: " javascript:alert(1)" } }] };
    expect(decideBlock(block({ params: nestedLink }), registry)).toMatchObject({
      ok: false,
      reason: "unsafe_link",
      detail: "bars[0].meta.href",
    });
    expect(decideBlock(block({ params: { html: "<img>" } }), registry)).toMatchObject({ reason: "unsafe_markup" });
    expect(decideBlock(block({ params: { onClick: "x" } }), registry)).toMatchObject({ reason: "unsafe_handler" });
  });

  it("only allows actions the capability declares", () => {
    expect(decideBlock(block({ allowedActions: ["local.sort"] }), registry).ok).toBe(true);
    expect(decideBlock(block({ allowedActions: ["plan.write"] }), registry)).toMatchObject({
      ok: false,
      reason: "illegal_action",
      detail: "plan.write",
    });
  });

  it("keeps rendering the remaining blocks when one fails", () => {
    const artifact: Artifact = {
      schemaVersion: "1",
      artifactId: "a1",
      revision: 1,
      provenance: { origin: "model" },
      blocks: [block({ id: "bad", capability: "unknown@1" }), block({ id: "good" })],
    };
    expect(decideArtifact(artifact, registry).map((d) => d.ok)).toEqual([false, true]);
  });

  it("prevents model-provenance artifacts from escalating to rules even if caller passes producer='rules'", () => {
    const hostCap = defineCapability({
      id: "host-secret@1",
      title: "Host",
      tasks: ["cite"],
      modes: ["text"],
      params: z.object({ text: z.string() }).strict(),
      limits: [],
      hostOnly: true,
      toText: ({ text }) => text,
    });
    const ruleCap = defineCapability({
      id: "witness-card@1",
      title: "Witness",
      tasks: ["cite"],
      modes: ["text"],
      params: z.object({ origin: z.literal("rules"), text: z.string() }).strict(),
      limits: [],
      toText: ({ text }) => text,
    });
    const extRegistry = createCapabilityRegistry([prose, hostCap, ruleCap]);
    expect(extRegistry.describe().map((c) => c.id)).toEqual(["prose@1", "witness-card@1"]);
    expect(extRegistry.describe({ includeHostOnly: true }).map((c) => c.id)).toEqual(["prose@1", "host-secret@1", "witness-card@1"]);

    const forgedArtifact: Artifact = {
      schemaVersion: "1",
      artifactId: "a2",
      revision: 1,
      provenance: { origin: "model" },
      blocks: [
        block({ id: "h", capability: "host-secret@1", params: { text: "x" } }),
        block({ id: "w", capability: "witness-card@1", params: { origin: "rules", text: "y" } }),
      ],
    };
    const forgedDecisions = decideArtifact(forgedArtifact, extRegistry, {}, { producer: "rules" });
    expect(forgedDecisions[0]).toMatchObject({ ok: false, reason: "unauthorized_capability" });
    expect(forgedDecisions[1]).toMatchObject({ ok: false, reason: "untrusted_provenance" });
  });

  it("rejects aiCandidateOnly capabilities without trusted host+artifact AI candidate provenance", () => {
    const aiCap = defineCapability({
      id: "ai-proposal@1",
      title: "Proposal",
      tasks: ["compare"],
      modes: ["text"],
      params: z.object({ aiCandidateOnly: z.literal(true), note: z.string() }).strict(),
      limits: [],
      hostOnly: true,
      aiCandidateOnly: true,
      toText: ({ note }) => note,
    });
    const extRegistry = createCapabilityRegistry([aiCap]);
    const proposalBlock = block({
      id: "p1",
      capability: "ai-proposal@1",
      params: { aiCandidateOnly: true, note: "candidate change" },
    });

    for (const origin of ["user", "import", "model", "rules"] as const) {
      const artifact: Artifact = {
        schemaVersion: "1",
        artifactId: `art-${origin}`,
        revision: 1,
        provenance: { origin },
        blocks: [proposalBlock],
      };
      expect(decideArtifact(artifact, extRegistry, {}, { producer: "host", aiCandidateProvenance: true })[0]).toMatchObject({
        ok: false,
        reason: "untrusted_provenance",
      });
    }

    for (const origin of ["ai_candidate", "assistant"] as const) {
      const candidateArtifact: Artifact = {
        schemaVersion: "1",
        artifactId: `art-${origin}`,
        revision: 1,
        provenance: { origin },
        blocks: [proposalBlock],
      };
      expect(decideArtifact(candidateArtifact, extRegistry, {}, { producer: "host" })[0]).toMatchObject({
        ok: false,
        reason: "untrusted_provenance",
      });
      expect(
        decideArtifact(candidateArtifact, extRegistry, {}, { producer: "host", aiCandidateProvenance: true })[0],
      ).toMatchObject({ ok: true, text: "candidate change" });
    }
  });
});

describe("artifactToText", () => {
  it("renders prose with limits and names skipped blocks", () => {
    const artifact: Artifact = {
      schemaVersion: "1",
      artifactId: "a1",
      revision: 1,
      title: "投入时间",
      provenance: { origin: "rules" },
      blocks: [block({ id: "chart", limits: ["数值未经核实"] }), block({ id: "x", capability: "unknown@1" })],
    };
    expect(artifactToText(artifact, registry)).toBe(
      "投入时间\n\n阅读：25分钟；练习：40分钟\n（数值未经核实）\n\n[已跳过一块内容：unknown_capability]",
    );
  });
});

describe("resolveDisplayMode", () => {
  it("honours text-only and walks down the ladder", () => {
    expect(resolveDisplayMode(["text", "static", "interactive"], { textOnly: true })).toBe("text");
    expect(resolveDisplayMode(["text", "static"])).toBe("static");
    expect(resolveDisplayMode(["text", "interactive"], { preferredMode: "static" })).toBe("text");
    // Reduced motion is a renderer hint, not a mode downgrade.
    expect(resolveDisplayMode(["text", "interactive"], { reducedMotion: true })).toBe("interactive");
  });
});

describe("sanitize", () => {
  it("flags dangerous URL schemes but allows prose that mentions them", () => {
    expect(isUnsafeUrl("data:text/html,x")).toBe(true);
    expect(isUnsafeUrl("https://example.com")).toBe(false);
    expect(findUnsafeContent({ text: "不要在链接里写 javascript: 前缀" })).toBeNull();
  });

  it("bounds nesting depth", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 12; i++) deep = (deep.child = {}) as Record<string, unknown>;
    expect(findUnsafeContent(root)).toMatchObject({ kind: "depth" });
  });
});
