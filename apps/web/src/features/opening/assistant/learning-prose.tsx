"use client";

import "katex/dist/katex.min.css";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { Parent as MdastParent, Root as MdastRoot, Text as MdastText } from "mdast";
import { Component, memo, useContext, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex, { type Options as KatexOptions } from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { isQueryEvidenceHref, type QueryEvidenceLink } from "./query-evidence-links";
import { ReplyRevealEnabled, ReplyTextGroup } from "./ai-response";

/** Model text is untrusted: no `trust` commands, capped sizes and macro expansion. */
const KATEX_OPTIONS: KatexOptions = { trust: false, strict: "ignore", maxSize: 10, maxExpand: 200, errorColor: "#b91c1c" };
const SAFE_LINK = /^(https?:|mailto:)/i;

/** Only absolute http(s)/mailto links survive; everything else loses its href. */
export function proseUrlTransform(url: string): string {
  return SAFE_LINK.test(url.trim()) ? url : "";
}

/** `data-src-*` hold the block's Markdown source offsets; selection-source.ts maps selections back through them. */
type SrcAttrs = { "data-src-start"?: number; "data-src-end"?: number };
const src = (props: object): SrcAttrs => {
  const { "data-src-start": start, "data-src-end": end } = props as SrcAttrs;
  return start === undefined ? {} : { "data-src-start": start, "data-src-end": end };
};

function stamp(node: Element) {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) Object.assign(node.properties, { dataSrcStart: start, dataSrcEnd: end });
}

function stampItems(nodes: ElementContent[]) {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tagName === "li") stamp(node);
    stampItems(node.children);
  }
}

const isDisplayMath = (node: Element) => node.tagName === "pre" && node.children.some((child) =>
  child.type === "element" && Array.isArray(child.properties.className) && child.properties.className.includes("math-display"));

export type CitationLink = { href: string; label: string };

/**
 * S4: the server stores `[k]` so that it always means citations[k-1]. Only
 * plain text nodes are scanned: code, math and links are other node types.
 * In-range markers become `<sup data-cite>`; anything else stays text.
 */
export function remarkCitationMarkers(options: { count: number }) {
  const split = (value: string): MdastText[] | undefined => {
    const parts: MdastText[] = [];
    let last = 0;
    for (const match of value.matchAll(/(?<!\w)\[(\d{1,2})\]/g)) {
      const n = Number(match[1]);
      if (n < 1 || n > options.count) continue;
      if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
      parts.push({ type: "text", value: match[0], data: { hName: "sup", hProperties: { dataCite: n } } });
      last = match.index + match[0].length;
    }
    if (!parts.length) return undefined;
    if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
    return parts;
  };
  const walk = (node: MdastParent) => {
    const children: MdastParent["children"] = [];
    for (const child of node.children) {
      if (child.type === "text") { children.push(...(split(child.value) ?? [child])); continue; }
      if ("children" in child && child.type !== "link" && child.type !== "linkReference") walk(child);
      children.push(child);
    }
    node.children = children;
  };
  return (tree: MdastRoot) => { if (options.count > 0) walk(tree); };
}

/** Runs before KaTeX: top-level blocks and list items get offsets; display math gets a wrapper KaTeX leaves intact. */
export function rehypeSourceOffsets() {
  return (tree: Root) => {
    tree.children = tree.children.map((node) => {
      if (node.type !== "element") return node;
      if (isDisplayMath(node)) {
        const wrapper: Element = { type: "element", tagName: "div", properties: {}, children: [node], position: node.position };
        stamp(wrapper);
        return wrapper;
      }
      stamp(node);
      stampItems(node.children);
      return node;
    });
  };
}

/** Only prose is grouped. Math, code, links and citations keep their complete DOM. */
export function rehypeReplyReveal() {
  if (typeof Intl.Segmenter !== "function") return () => undefined;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return (tree: Root) => {
    let order = 0;
    const walk = (parent: Root | Element) => {
      parent.children = (parent.children as RootContent[]).flatMap<RootContent>(node => {
        if (node.type === "text") {
          if (!node.value.trim()) return [node];
          const letters = Array.from(segmenter.segment(node.value), part => part.segment);
          const groups: Element[] = [];
          for (let index = 0; index < letters.length; index += 2) groups.push({ type: "element", tagName: "span", properties: { dataReplyReveal: ++order }, children: [{ type: "text", value: letters.slice(index, index + 2).join("") }] });
          return groups;
        }
        if (node.type === "element" && !["a", "code", "pre", "sup"].includes(node.tagName)
          && !(Array.isArray(node.properties.className) && node.properties.className.some(name => String(name).startsWith("katex")))) walk(node);
        return [node];
      }) as ElementContent[];
    };
    walk(tree);
  };
}

const components: Components = {
  span: ({ children, node, ...props }) => {
    const order = Number(node?.properties.dataReplyReveal);
    return Number.isFinite(order) ? <ReplyTextGroup order={order}>{children}</ReplyTextGroup> : <span {...props}>{children}</span>;
  },
  p: ({ children, ...props }) => <p {...src(props)} className="my-3 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children, ...props }) => <h3 {...src(props)} className="mb-2 mt-5 text-base font-semibold text-text first:mt-0">{children}</h3>,
  h2: ({ children, ...props }) => <h3 {...src(props)} className="mb-2 mt-5 text-base font-semibold text-text first:mt-0">{children}</h3>,
  h3: ({ children, ...props }) => <h4 {...src(props)} className="mb-1.5 mt-4 font-semibold text-text first:mt-0">{children}</h4>,
  h4: ({ children, ...props }) => <h4 {...src(props)} className="mb-1.5 mt-4 font-semibold text-text first:mt-0">{children}</h4>,
  ul: ({ children, ...props }) => <ul {...src(props)} className="my-3 list-disc space-y-1 pl-6 marker:text-text-3">{children}</ul>,
  ol: ({ children, ...props }) => <ol {...src(props)} className="my-3 list-decimal space-y-1 pl-6 marker:text-text-2">{children}</ol>,
  blockquote: ({ children, ...props }) => <blockquote {...src(props)} className="my-3 border-l-2 border-line-strong pl-4 text-text-2">{children}</blockquote>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{children}</a>
    : <span>{children}</span>,
  // No remote images in answers: they would leak the reader to arbitrary hosts.
  img: ({ alt }) => alt ? <span className="text-text-2">[图片：{alt}]</span> : null,
  pre: ({ children, ...props }) => <pre {...src(props)} className="my-3 overflow-x-auto rounded-lg bg-ink px-4 py-3 text-[13px] leading-6 text-on-ink">{children}</pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[length:max(12px,0.9em)] text-text">{children}</code>,
  table: ({ children, ...props }) => <div {...src(props)} className="my-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border-b border-line-strong px-3 py-1.5 text-left font-semibold text-text">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-3 py-1.5 align-top">{children}</td>,
  hr: (props) => <hr {...src(props)} className="my-5 border-line" />,
  li: ({ children, ...props }) => <li {...src(props)}>{children}</li>,
};

export class PlainTextFallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn("learning prose render failed; showing plain text", error); }
  render() {
    return this.state.failed ? <p className="whitespace-pre-wrap">{this.props.text}</p> : this.props.children;
  }
}

const CITE_LINK_CLASS = "ml-0.5 rounded font-medium text-accent no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
const NO_CITATIONS: readonly CitationLink[] = [];
type LearningProseProps = { text: string; citationLinks?: readonly CitationLink[]; queryEvidenceLinks?: readonly QueryEvidenceLink[]; objectHref?: (href: string) => string };

/** Citation links are derived by the message list; equivalent links do not require reparsing math. */
export function sameLearningProseContent(previous: LearningProseProps, next: LearningProseProps): boolean {
  if (previous.text !== next.text || previous.objectHref !== next.objectHref) return false;
  const beforeEvidence = previous.queryEvidenceLinks ?? NO_CITATIONS;
  const afterEvidence = next.queryEvidenceLinks ?? NO_CITATIONS;
  if (beforeEvidence.length !== afterEvidence.length || beforeEvidence.some((link, index) =>
    link.href !== afterEvidence[index]?.href || link.label !== afterEvidence[index]?.label)) return false;
  const before = previous.citationLinks ?? NO_CITATIONS;
  const after = next.citationLinks ?? NO_CITATIONS;
  return before.length === after.length && before.every((link, index) =>
    link.href === after[index]?.href && link.label === after[index]?.label);
}

/**
 * Assistant answer body: GFM + math, raw HTML dropped, falls back to the original text on failure.
 * `citationLinks[k-1]` is where an inline `[k]` points; without it markers stay plain text.
 */
export const LearningProse = memo(function LearningProse({ text, citationLinks = NO_CITATIONS, queryEvidenceLinks = NO_CITATIONS, objectHref }: LearningProseProps) {
  const reveal = useContext(ReplyRevealEnabled);
  const approvedHrefs = useMemo(() => new Set(queryEvidenceLinks.map(link => link.href).filter(isQueryEvidenceHref)), [queryEvidenceLinks]);
  const withCitations = useMemo<Components>(() => ({
    ...components,
    a: ({ href, children }) => href && approvedHrefs.has(href)
      ? <Link href={objectHref?.(href) ?? href} className="text-accent underline decoration-accent/40 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{children}</Link>
      : href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{children}</a> : <span>{children}</span>,
    sup: ({ children, ...props }) => {
      const link = citationLinks[Number((props as { "data-cite"?: number })["data-cite"]) - 1];
      return link
        ? <sup className="text-xs"><a href={link.href} title={link.label} aria-label={`来源 ${String(children)}：${link.label}`} className={CITE_LINK_CLASS}>{children}</a></sup>
        : <sup>{children}</sup>;
    },
  }), [citationLinks, approvedHrefs, objectHref]);
  return <PlainTextFallback text={text}>
    <div className="font-reading text-[17px] leading-[30px] break-words [&_.katex]:text-[1.05em] [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath, [remarkCitationMarkers, { count: citationLinks.length }]]}
        rehypePlugins={[rehypeSourceOffsets, [rehypeKatex, KATEX_OPTIONS], ...(reveal ? [rehypeReplyReveal] : [])]}
        skipHtml
        urlTransform={(url, key) => key === "href" && approvedHrefs.has(url) ? url : proseUrlTransform(url)}
        components={withCitations}
      >{text}</Markdown>
    </div>
  </PlainTextFallback>;
}, sameLearningProseContent);
