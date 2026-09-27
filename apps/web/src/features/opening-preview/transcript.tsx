"use client";

import type { SampleMessage } from "./model";

export function Transcript(props: {
  messages: SampleMessage[];
  openCitationId: string | null;
  onCitation: (id: string) => void;
  onDownload: () => void;
}) {
  if (props.messages.length === 0) {
    return <p className="py-8 text-sm leading-6 text-zinc-600">这个对话还是空的。可以直接输入，也可以先从右侧选择可阅读材料。</p>;
  }
  return (
    <ol aria-live="polite" className="max-h-[28rem] space-y-4 overflow-auto py-4">
      {props.messages.map((message) => (
        <li className={message.role === "user" ? "ml-8" : "mr-8"} key={message.id}>
          <p className="text-xs font-medium text-zinc-500">{message.role === "user" ? "我" : "示例说明"}</p>
          <p className="mt-1 text-sm leading-7 text-zinc-900">{message.text}</p>
          {message.citationId ? (
            <div className="mt-1">
              <button aria-expanded={props.openCitationId === message.citationId} className="min-h-11 text-sm font-medium text-indigo-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={() => props.onCitation(message.citationId!)} type="button">
                查看来源
              </button>
              {props.openCitationId === message.citationId ? (
                <div className="mt-1 rounded-md bg-white px-3 py-2 text-sm text-zinc-700 ring-1 ring-zinc-200" id={`cite-${message.citationId}`}>
                  <p>高等数学 · 极限与连续 · 示例版本 1 · 第 12 页</p>
                  <button className="mt-1 min-h-11 font-medium text-indigo-700 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={props.onDownload} type="button">下载原件（模拟）</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
