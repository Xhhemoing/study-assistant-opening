import { FileImage, FileText, List, ListOrdered } from "lucide-react";

import { BlockView } from "./block-view";
import type { ImportedPage, ImportedProperty } from "./notion-import-parser";

function PropertyRow({ property }: { property: ImportedProperty }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-stone-500">{property.name}</dt>
      <dd className="text-stone-300">{property.value}</dd>
    </div>
  );
}

export function DocumentPreview({ page }: { page: ImportedPage }) {
  return (
    <article className="mx-auto max-w-[46rem] px-6 pb-16 pt-10 sm:px-10">
      <header className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-white/5 text-amber-200"><FileText aria-hidden="true" size={18} /></span>
        <h1 className="text-2xl font-semibold text-stone-50">{page.title}</h1>
      </header>
      {page.properties.length > 0 ? (
        <dl className="mt-5 grid gap-2 rounded-lg border border-white/10 p-4 sm:grid-cols-2">
          {page.properties.map((property) => <PropertyRow key={property.name} property={property} />)}
        </dl>
      ) : null}
      <div className="mt-10 space-y-7">
        {page.blocks.map((block, index) => (
          <div className="group" key={index}>
            <BlockView block={block} />
          </div>
        ))}
      </div>
      {page.blocks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-700 p-6 text-center text-sm text-stone-500">
          此页面没有可解析的内容块
        </p>
      ) : null}
      <footer className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/10 pt-4 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1"><List aria-hidden="true" size={12} />{page.blocks.length} 个内容块</span>
        <span className="inline-flex items-center gap-1"><FileImage aria-hidden="true" size={12} />{page.attachments.length} 个附件</span>
        <span className="inline-flex items-center gap-1"><ListOrdered aria-hidden="true" size={12} />{page.links.length} 个内部链接</span>
      </footer>
    </article>
  );
}
