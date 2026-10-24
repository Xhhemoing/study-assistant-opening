import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";
import type { Root as HastRoot } from "hast";
import { describe, expect, it, vi } from "vitest";
import { remarkConceptAnchors, type ConceptAnchor } from "../concepts/remark-concept-anchors";
import { ConceptAnchorButton, LearningProse, rehypeReplyReveal, remarkCitationMarkers, sameLearningProseContent } from "./learning-prose";
import { ReplyRevealEnabled } from "./ai-response";

const candidates = [{ label: "梯度", id: "gradient" }, { label: "梯度下降", id: "descent" }];
const nodes = (root: Nodes): Nodes[] => [root, ...("children" in root ? root.children.flatMap(nodes) : [])];
const anchors = (root: Root) => nodes(root).filter(node => node.data?.hName === "button");
const transform = (text: string, mapping: readonly ConceptAnchor[] = candidates) => {
  const tree = fromMarkdown(text);
  remarkConceptAnchors({ candidates: mapping })(tree, { value: text });
  return tree;
};
const render = (text: string, mapping: readonly ConceptAnchor[] = candidates, onConcept?: (id: string) => void) =>
  renderToStaticMarkup(createElement(LearningProse, { text, conceptAnchors: mapping, onConcept }));

describe("caller-mapped concept anchors (render capability only)", () => {
  it("chooses longest matches, anchors each label once per block across emphasis, and keeps source offsets", () => {
    const text = "梯度下降与**梯度**，梯度下降与梯度。\n\n梯度下降。";
    const tree = transform(text);
    const marked = anchors(tree);
    expect(marked.map(node => node.data?.hProperties?.dataConceptId)).toEqual(["descent", "gradient", "descent"]);
    for (const node of marked) {
      expect(node.type).toBe("text");
      if (node.type === "text") expect(text.slice(node.position?.start.offset, node.position?.end.offset)).toBe(node.value);
    }
    expect(tree.position?.end.offset).toBe(text.length);
    expect(nodes(tree).filter(node => node.type === "text").map(node => node.type === "text" ? node.value : "").join("")).toBe("梯度下降与梯度，梯度下降与梯度。梯度下降。");
  });

  it("fails closed on ambiguous labels while deduplicating identical mappings", () => {
    expect(anchors(transform("梯度", [{ label: "梯度", id: "a" }, { label: "梯度", id: "b" }]))).toEqual([]);
    expect(anchors(transform("梯度", [{ label: "梯度", id: "a" }, { label: "梯度", id: "a" }]))).toHaveLength(1);
  });

  it("does not fall back to a shorter label inside an already-seen longest term", () => {
    const tree = transform("梯度下降 梯度下降 梯度");
    expect(anchors(tree).map(node => node.type === "text" ? node.value : "")).toEqual(["梯度下降", "梯度"]);
    const treeWithMath: Root = { type: "root", children: [{ type: "paragraph", children: [{ type: "inlineMath", value: "梯度" }, { type: "text", value: "梯度" }] }, { type: "math", value: "梯度" }] };
    remarkConceptAnchors({ candidates })(treeWithMath);
    expect(anchors(treeWithMath)).toHaveLength(1);
    expect(treeWithMath.children[1]).toEqual({ type: "math", value: "梯度" });
  });

  it("does not scan code, links, citations, or existing concept nodes", () => {
    const text = "`梯度` [梯度](https://example.com) [梯度][ref] [1] 梯度\n\n```\n梯度\n```\n\n[ref]: https://example.com";
    const tree = fromMarkdown(text);
    remarkCitationMarkers({ count: 1 })(tree);
    remarkConceptAnchors({ candidates: [...candidates, { label: "1", id: "one" }] })(tree, { value: text });
    expect(anchors(tree)).toHaveLength(1);
    const first = anchors(tree)[0];
    remarkConceptAnchors({ candidates })(tree, { value: text });
    expect(anchors(tree)).toEqual([first]);
    expect(anchors(transform("[1]", [{ label: "1", id: "one" }]))).toHaveLength(0);
  });

  it("preserves decoded text and does not invent offsets for escaped/entity text", () => {
    const tree = transform("a &amp; 梯度", [{ label: "梯度", id: "g" }]);
    expect(anchors(tree)[0]?.position).toBeUndefined();
    expect(tree.children[0]?.position?.end.offset).toBe("a &amp; 梯度".length);
  });

  it("is a no-op without supplied candidates or activation callback", () => {
    const text = "梯度 **下降**";
    const baseline = renderToStaticMarkup(createElement(LearningProse, { text }));
    expect(render(text)).toBe(baseline);
    expect(render(text, [], vi.fn())).toBe(baseline);
    const tree = fromMarkdown(text), original = structuredClone(tree);
    remarkConceptAnchors({ candidates: [] })(tree);
    expect(tree).toEqual(original);
  });

  it("renders native buttons only for plain prose; math, raw HTML and images stay untrusted", () => {
    const html = render("梯度 $梯度$ `梯度` [梯度](https://example.com) [1]\n\n![梯度](https://tracker.example/image.png)\n\n<button data-concept-id=evil>坏</button>", candidates, vi.fn());
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain('type="button" data-concept-id="gradient"');
    expect(html).toContain("katex");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('data-concept-id="evil"');
  });

  it("keeps paragraph source offsets and concept buttons intact during reply reveal", () => {
    const text = "先看梯度下降，再看梯度。";
    const html = renderToStaticMarkup(createElement(ReplyRevealEnabled.Provider, { value: true }, createElement(LearningProse, { text, conceptAnchors: candidates, onConcept: vi.fn() })));
    expect(html).toContain(`data-src-start="0" data-src-end="${text.length}"`);
    expect(html).toMatch(/<button[^>]*>梯度下降<\/button>/);
    const tree: HastRoot = { type: "root", children: [{ type: "element", tagName: "button", properties: { dataConceptId: "g" }, children: [{ type: "text", value: "梯度下降" }] }] };
    const before = structuredClone(tree);
    rehypeReplyReveal()(tree);
    expect(tree).toEqual(before);
  });

  it("dispatches only the caller ID at the click boundary; native button retains keyboard semantics", () => {
    const onConcept = vi.fn();
    const button = ConceptAnchorButton({ id: "gradient", candidates, onConcept, children: "梯度" }) as ReactElement<{ type: string; onClick: () => void; tabIndex?: number }>;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.tabIndex).toBeUndefined();
    expect(onConcept).not.toHaveBeenCalled();
    button.props.onClick();
    expect(onConcept).toHaveBeenCalledExactlyOnceWith("gradient");
    const rejected = ConceptAnchorButton({ id: "invented", candidates, onConcept, children: "伪节点" }) as ReactElement;
    expect(rejected.type).not.toBe("button");
  });

  it("memo invalidates candidate IDs, labels and callback identity", () => {
    const onConcept = vi.fn(), previous = { text: "梯度", conceptAnchors: candidates, onConcept };
    expect(sameLearningProseContent(previous, { ...previous, conceptAnchors: candidates.map(item => ({ ...item })) })).toBe(true);
    expect(sameLearningProseContent(previous, { ...previous, conceptAnchors: [{ label: "梯度", id: "changed" }] })).toBe(false);
    expect(sameLearningProseContent(previous, { ...previous, conceptAnchors: [{ ...candidates[0]!, label: "变化" }, candidates[1]!] })).toBe(false);
    expect(sameLearningProseContent(previous, { ...previous, onConcept: vi.fn() })).toBe(false);
  });
});
