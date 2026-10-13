"use client";

import "katex/dist/katex.min.css";
import { Component, type ReactNode } from "react";
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

const components: Components = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-950 first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-950 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-4 font-semibold text-zinc-900 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1.5 mt-4 font-semibold text-zinc-900 first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 marker:text-zinc-400">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-zinc-500">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-zinc-300 pl-4 text-zinc-600">{children}</blockquote>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline decoration-emerald-700/30 underline-offset-2 hover:decoration-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50">{children}</a>
    : <span>{children}</span>,
  // No remote images in answers: they would leak the reader to arbitrary hosts.
  img: ({ alt }) => alt ? <span className="text-zinc-500">[图片：{alt}]</span> : null,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-lg bg-zinc-950 px-4 py-3 text-[13px] leading-6 text-zinc-100">{children}</pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] text-zinc-800">{children}</code>,
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border-b border-zinc-300 px-3 py-1.5 text-left font-semibold text-zinc-900">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-200 px-3 py-1.5 align-top">{children}</td>,
  hr: () => <hr className="my-5 border-zinc-200" />,
};

export class PlainTextFallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn("learning prose render failed; showing plain text", error); }
  render() {
    return this.state.failed ? <p className="whitespace-pre-wrap">{this.props.text}</p> : this.props.children;
  }
}

/** Assistant answer body: GFM + math, raw HTML dropped, falls back to the original text on failure. */
export function LearningProse({ text }: { text: string }) {
  return <PlainTextFallback text={text}>
    <div className="break-words [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
        skipHtml
        urlTransform={proseUrlTransform}
        components={components}
      >{text}</Markdown>
    </div>
  </PlainTextFallback>;
}
