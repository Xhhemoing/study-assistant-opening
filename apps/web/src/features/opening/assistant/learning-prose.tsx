"use client";

import "katex/dist/katex.min.css";
import type { Element, ElementContent, Root } from "hast";
import type { Parent as MdastParent, Root as MdastRoot, Text as MdastText } from "mdast";
import { Component, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex, { type Options as KatexOptions } from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

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

const components: Components = {
  p: ({ children, ...props }) => <p {...src(props)} className="my-3 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children, ...props }) => <h3 {...src(props)} className="mb-2 mt-5 text-base font-semibold text-zinc-950 first:mt-0">{children}</h3>,
  h2: ({ children, ...props }) => <h3 {...src(props)} className="mb-2 mt-5 text-base font-semibold text-zinc-950 first:mt-0">{children}</h3>,
  h3: ({ children, ...props }) => <h4 {...src(props)} className="mb-1.5 mt-4 font-semibold text-zinc-900 first:mt-0">{children}</h4>,
  h4: ({ children, ...props }) => <h4 {...src(props)} className="mb-1.5 mt-4 font-semibold text-zinc-900 first:mt-0">{children}</h4>,
  ul: ({ children, ...props }) => <ul {...src(props)} className="my-3 list-disc space-y-1 pl-6 marker:text-zinc-400">{children}</ul>,
  ol: ({ children, ...props }) => <ol {...src(props)} className="my-3 list-decimal space-y-1 pl-6 marker:text-zinc-500">{children}</ol>,
  blockquote: ({ children, ...props }) => <blockquote {...src(props)} className="my-3 border-l-2 border-zinc-300 pl-4 text-zinc-600">{children}</blockquote>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline decoration-emerald-700/30 underline-offset-2 hover:decoration-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50">{children}</a>
    : <span>{children}</span>,
  // No remote images in answers: they would leak the reader to arbitrary hosts.
  img: ({ alt }) => alt ? <span className="text-zinc-500">[图片：{alt}]</span> : null,
  pre: ({ children, ...props }) => <pre {...src(props)} className="my-3 overflow-x-auto rounded-lg bg-zinc-950 px-4 py-3 text-[13px] leading-6 text-zinc-100">{children}</pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] text-zinc-800">{children}</code>,
  table: ({ children, ...props }) => <div {...src(props)} className="my-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border-b border-zinc-300 px-3 py-1.5 text-left font-semibold text-zinc-900">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-200 px-3 py-1.5 align-top">{children}</td>,
  hr: (props) => <hr {...src(props)} className="my-5 border-zinc-200" />,
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

const CITE_LINK_CLASS = "ml-0.5 rounded font-medium text-emerald-700 no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50";

/**
 * Assistant answer body: GFM + math, raw HTML dropped, falls back to the original text on failure.
 * `citationLinks[k-1]` is where an inline `[k]` points; without it markers stay plain text.
 */
export function LearningProse({ text, citationLinks = [] }: { text: string; citationLinks?: readonly CitationLink[] }) {
  const withCitations = useMemo<Components>(() => citationLinks.length ? {
    ...components,
    sup: ({ children, ...props }) => {
      const link = citationLinks[Number((props as { "data-cite"?: number })["data-cite"]) - 1];
      return link
        ? <sup className="text-[0.7em]"><a href={link.href} title={link.label} aria-label={`来源 ${String(children)}：${link.label}`} className={CITE_LINK_CLASS}>{children}</a></sup>
        : <sup>{children}</sup>;
    },
  } : components, [citationLinks]);
  return <PlainTextFallback text={text}>
    <div className="break-words [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath, [remarkCitationMarkers, { count: citationLinks.length }]]}
        rehypePlugins={[rehypeSourceOffsets, [rehypeKatex, KATEX_OPTIONS]]}
        skipHtml
        urlTransform={proseUrlTransform}
        components={withCitations}
      >{text}</Markdown>
    </div>
  </PlainTextFallback>;
}
