import { Check, ChevronDown, FileImage, Link2, Square, TriangleAlert } from "lucide-react";

import type { ImportedBlock } from "./notion-import-parser";

const lossLabels: Record<string, string> = {
  "toggle-flattened": "折叠已展平",
  "callout-style": "提示框样式降级",
  "columns-flattened": "多栏已展平",
  "embed-lost": "嵌入内容丢失",
  "equation-lost": "公式降级",
  "color-lost": "颜色丢失",
  "attribute-lost": "属性丢失",
};

function LossBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
      <TriangleAlert aria-hidden="true" size={11} />
      {lossLabels[kind] ?? kind}
    </span>
  );
}

function LinkText({ text, links }: { text: string; links: { pageId: string; label: string }[] }) {
  const link = links[0];
  if (!link) return <>{text}</>;
  const index = text.indexOf(link.label);
  if (index === -1) {
    return (
      <>
        {text}
        <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
          <Link2 aria-hidden="true" size={11} />{link.label}
        </span>
      </>
    );
  }
  return (
    <>
      {text.slice(0, index)}
      <span className="rounded bg-emerald-50 px-1 text-emerald-800">{link.label}</span>
      {text.slice(index + link.label.length)}
    </>
  );
}

function ToggleView({ block }: { block: ImportedBlock }) {
  return (
    <section className="border-y border-zinc-200 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-zinc-900">
        <ChevronDown aria-hidden="true" className="text-zinc-500" size={16} />
        {block.text}
        {(block.losses ?? []).map((loss) => <LossBadge key={loss} kind={loss} />)}
      </div>
      {block.children && block.children.length > 0 ? (
        <div className="mt-3 space-y-3 pl-6">
          {block.children.map((child, index) => <BlockView block={child} key={index} />)}
        </div>
      ) : null}
    </section>
  );
}

export function BlockView({ block }: { block: ImportedBlock }) {
  switch (block.type) {
    case "heading":
      if (block.level === 1) return <h2 className="text-lg font-semibold leading-snug text-zinc-900">{block.text}</h2>;
      if (block.level === 2) return <h3 className="text-base font-semibold leading-snug text-zinc-900">{block.text}</h3>;
      return <h4 className="text-base font-semibold leading-snug text-zinc-900">{block.text}</h4>;
    case "paragraph":
      return (
        <p className="leading-7 text-zinc-700">
          {block.links && block.links.length > 0 ? (
            <LinkText links={block.links} text={block.text} />
          ) : (
            block.text
          )}
        </p>
      );
    case "bulleted-list":
      return (
        <ul className="space-y-1.5">
          {(block.items ?? []).map((item, index) => (
            <li className="flex gap-2 text-zinc-700" key={index}>
              <span className="mt-3 size-1 shrink-0 rounded-full bg-zinc-400" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      );
    case "numbered-list":
      return (
        <ol className="space-y-1.5">
          {(block.items ?? []).map((item, index) => (
            <li className="flex gap-2.5 text-zinc-700" key={index}>
              <span className="w-5 shrink-0 text-right font-mono text-sm text-zinc-500">{index + 1}.</span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ol>
      );
    case "to-do":
      return (
        <div className="flex items-start gap-2.5 text-zinc-700">
          {block.checked ? (
            <span className="mt-1 grid size-4 shrink-0 place-items-center rounded border border-emerald-300/60 bg-emerald-300/15 text-emerald-700"><Check aria-hidden="true" size={12} /></span>
          ) : (
            <span className="mt-1 grid size-4 shrink-0 place-items-center rounded border border-zinc-300 text-zinc-600"><Square aria-hidden="true" size={10} /></span>
          )}
          <span className={block.checked ? "text-zinc-500 line-through" : "min-w-0"}>{block.text}</span>
        </div>
      );
    case "toggle":
      return <ToggleView block={block} />;
    case "callout":
      return (
        <section className="border-l border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[15px] leading-7 text-amber-900">
            {block.text}
            {(block.losses ?? []).map((loss) => <LossBadge key={loss} kind={loss} />)}
          </div>
        </section>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-[13px] leading-6 text-zinc-800">
          {block.text}
        </pre>
      );
    case "image":
      return (
        <figure className="flex items-center gap-3 rounded-lg border border-dashed border-zinc-200 px-4 py-5">
          <FileImage aria-hidden="true" className="text-zinc-500" size={20} />
          <figcaption className="min-w-0 truncate text-sm text-zinc-500">{block.src ?? "图片附件"}</figcaption>
        </figure>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {(block.rows ?? []).map((row, rowIndex) => (
                <tr className="border-b border-zinc-200 last:border-b-0" key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td className={rowIndex === 0 ? "px-3 py-2.5 font-medium text-zinc-900" : "px-3 py-2.5 text-zinc-700"} key={cellIndex}>
                      {cell || "\u00A0"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "divider":
      return <hr className="border-zinc-200" />;
    case "columns":
      return (
        <div className="grid gap-6 sm:grid-cols-2">
          {(block.columns ?? []).map((column, index) => (
            <div className="min-w-0 space-y-5" key={index}>
              {column.map((child, childIndex) => <BlockView block={child} key={childIndex} />)}
            </div>
          ))}
        </div>
      );
    case "unknown":
      return <p className="italic text-zinc-500">{block.text}</p>;
    default:
      return null;
  }
}
