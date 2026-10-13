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
