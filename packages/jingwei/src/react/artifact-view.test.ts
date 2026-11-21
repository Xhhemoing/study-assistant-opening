import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Artifact, ArtifactBlock } from "../artifact";
import { createCapabilityRegistry, defineCapability } from "../capability";
import { ArtifactView, BlockView, defineRenderer, type RendererMap } from "./artifact-view";
import { RENDER_FAILED_NOTE, RenderBoundary } from "./render-boundary";

const bars = defineCapability<{ values: number[] }>({
  id: "bars@1",
  title: "条形",
  tasks: ["compare"],
  modes: ["text", "static", "interactive"],
  params: z.object({ values: z.array(z.number()).min(2) }).strict(),
  limits: [],
  toText: ({ values }) => `数值：${values.join("、")}`,
});
const registry = createCapabilityRegistry([bars]);
const renderers: RendererMap = {
  "bars@1": defineRenderer<{ values: number[] }>(({ params, mode }) =>
    createElement("svg", { "data-mode": mode, "aria-label": `${params.values.length} 根条形` }),
  ),
};

function block(overrides: Partial<ArtifactBlock> = {}): ArtifactBlock {
  return { id: "b1", capability: "bars@1", params: { values: [1, 2] }, allowedActions: [], limits: [], sourceRefs: [], ...overrides };
}

const render = (props: Partial<Parameters<typeof BlockView>[0]> = {}) =>
  renderToStaticMarkup(createElement(BlockView, { block: block(), registry, renderers, ...props }));

describe("BlockView", () => {
  it("mounts the host renderer in the resolved mode", () => {
    const html = render();
    expect(html).toContain('data-jingwei-mode="interactive"');
    expect(html).toContain('data-mode="interactive"');
    expect(render({ prefs: { preferredMode: "static" } })).toContain('data-mode="static"');
  });

  it("uses the capability's text in text mode and when the host has no renderer", () => {
    for (const html of [render({ prefs: { textOnly: true } }), render({ renderers: {} })]) {
      expect(html).toContain("数值：1、2");
      expect(html).toContain('data-jingwei-mode="text"');
      expect(html).not.toContain("<svg");
    }
  });

  it("shows a skip reason without inventing content, or the host's own card", () => {
    const skipped = render({ block: block({ params: { values: [] } }) });
    expect(skipped).toContain('data-jingwei-skipped="invalid_params"');
    expect(skipped).toContain("不补造数值");
    const custom = render({
      block: block({ capability: "nope@1" }),
      renderSkipped: (d) => createElement("p", null, `host:${d.reason}`),
    });
    expect(custom).toContain("host:unknown_capability");
  });

  it("surfaces block limits next to the content", () => {
    expect(render({ block: block({ limits: ["动画不构成证明"] }) })).toContain("动画不构成证明");
  });
});

describe("ArtifactView", () => {
  it("renders every block and tags the revision", () => {
    const artifact: Artifact = {
      schemaVersion: "1",
      artifactId: "a1",
      revision: 3,
      title: "比较",
      provenance: { origin: "rules" },
      blocks: [block({ id: "x", capability: "nope@1" }), block({ id: "y" })],
    };
    const html = renderToStaticMarkup(createElement(ArtifactView, { artifact, registry, renderers }));
    expect(html).toContain('data-jingwei-revision="3"');
    expect(html).toContain('data-jingwei-skipped="unknown_capability"');
    expect(html).toContain('data-jingwei-block="y"');
  });

  it("downgrades caller producer='rules' when artifact provenance is not rules", () => {
    const ruleCap = defineCapability<{ values: number[]; origin?: string }>({
      id: "rule-bars@1",
      title: "规则条形",
      tasks: ["compare"],
      modes: ["text", "static", "interactive"],
      params: z.object({ values: z.array(z.number()).min(2), origin: z.string().optional() }).strict(),
      limits: [],
      toText: ({ values }) => `规则：${values.join("、")}`,
    });
    const ruleRegistry = createCapabilityRegistry([ruleCap]);
    const ruleRenderers: RendererMap = {
      "rule-bars@1": defineRenderer<{ values: number[] }>(({ params, mode }) =>
        createElement("svg", { "data-mode": mode, "aria-label": `${params.values.length} 根规则条形` }),
      ),
    };
    const modelForgedArtifact: Artifact = {
      schemaVersion: "1",
      artifactId: "a-forged",
      revision: 1,
      provenance: { origin: "model" },
      blocks: [block({ id: "r1", capability: "rule-bars@1", params: { values: [1, 2], origin: "rules" } })],
    };
    const downgradedHtml = renderToStaticMarkup(
      createElement(ArtifactView, {
        artifact: modelForgedArtifact,
        registry: ruleRegistry,
        renderers: ruleRenderers,
        producer: "rules",
      }),
    );
    expect(downgradedHtml).toContain('data-jingwei-skipped="untrusted_provenance"');

    const rulesArtifact: Artifact = {
      ...modelForgedArtifact,
      artifactId: "a-rules",
      provenance: { origin: "rules" },
    };
    const rulesHtml = renderToStaticMarkup(
      createElement(ArtifactView, {
        artifact: rulesArtifact,
        registry: ruleRegistry,
        renderers: ruleRenderers,
        producer: "rules",
      }),
    );
    expect(rulesHtml).toContain('data-jingwei-mode="interactive"');
  });

  it("enforces trusted AI candidate provenance for aiCandidateOnly capabilities in ArtifactView", () => {
    const proposalCap = defineCapability<{ aiCandidateOnly: true; summary: string }>({
      id: "proposal-diff@1",
      title: "候选修订",
      tasks: ["compare"],
      modes: ["text", "static"],
      params: z.object({ aiCandidateOnly: z.literal(true), summary: z.string() }).strict(),
      limits: [],
      hostOnly: true,
      aiCandidateOnly: true,
      toText: ({ summary }) => summary,
    });
    const proposalRegistry = createCapabilityRegistry([proposalCap]);
    const proposalRenderers: RendererMap = {
      "proposal-diff@1": defineRenderer<{ aiCandidateOnly: true; summary: string }>(({ params }) =>
        createElement("div", { "data-proposal": "ok" }, params.summary),
      ),
    };
    const proposalBlock = block({
      id: "p1",
      capability: "proposal-diff@1",
      params: { aiCandidateOnly: true, summary: "改写第2步" },
    });

    for (const origin of ["user", "import", "model", "rules"] as const) {
      const untrustedArtifact: Artifact = {
        schemaVersion: "1",
        artifactId: `view-${origin}`,
        revision: 1,
        provenance: { origin },
        blocks: [proposalBlock],
      };
      const html = renderToStaticMarkup(
        createElement(ArtifactView, {
          artifact: untrustedArtifact,
          registry: proposalRegistry,
          renderers: proposalRenderers,
          producer: "host",
          aiCandidateProvenance: true,
        }),
      );
      expect(html).toContain('data-jingwei-skipped="untrusted_provenance"');
      expect(html).not.toContain('data-proposal="ok"');
    }

    const aiArtifact: Artifact = {
      schemaVersion: "1",
      artifactId: "view-ai",
      revision: 1,
      provenance: { origin: "ai_candidate" },
      blocks: [proposalBlock],
    };
    const withoutHostAttestation = renderToStaticMarkup(
      createElement(ArtifactView, {
        artifact: aiArtifact,
        registry: proposalRegistry,
        renderers: proposalRenderers,
        producer: "host",
      }),
    );
    expect(withoutHostAttestation).toContain('data-jingwei-skipped="untrusted_provenance"');

    const trustedHtml = renderToStaticMarkup(
      createElement(ArtifactView, {
        artifact: aiArtifact,
        registry: proposalRegistry,
        renderers: proposalRenderers,
        producer: "host",
        aiCandidateProvenance: true,
      }),
    );
    expect(trustedHtml).toContain('data-proposal="ok"');
  });
});

describe("RenderBoundary", () => {
  it("falls back to text after an error and retries on a new reset key", () => {
    const failed = RenderBoundary.getDerivedStateFromError();
    expect(failed).toEqual({ failed: true });
    expect(RenderBoundary.getDerivedStateFromProps({ resetKey: 1 } as never, { failed: true, resetKey: 1 })).toBeNull();
    expect(RenderBoundary.getDerivedStateFromProps({ resetKey: 2 } as never, { failed: true, resetKey: 1 })).toEqual({
      failed: false,
      resetKey: 2,
    });
    const boundary = new RenderBoundary({ fallbackText: "文字版", resetKey: 1, children: null });
    boundary.state = { failed: true, resetKey: 1 };
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain(RENDER_FAILED_NOTE);
    expect(html).toContain("文字版");
  });
});
