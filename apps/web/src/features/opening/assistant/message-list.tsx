"use client";

import type { ChatMessageView } from "./message-model";
import { sourceDownloadHref, sourceViewerCopy } from "../inbox/source-viewer";

type Props = {
  messages: ChatMessageView[];
  historyTruncated?: boolean;
  currentVersions?: Readonly<Record<string, number>>;
};

export function MessageList({ messages, historyTruncated, currentVersions = {} }: Props) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3" role="log" aria-live="polite">
      {historyTruncated ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          更早的对话已截断；当前为服务端组装的有界历史。
        </p>
      ) : null}
      {messages.length === 0 ? (
        <p className="text-sm text-zinc-500">还没有消息。自由交流，也可基于已选材料提问。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {messages.map((message) => (
            <li
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-8 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white"
                  : "mr-8 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-900"
              }
            >
              <p className="whitespace-pre-wrap">{message.text}</p>
              {(message.citations ?? []).length > 0 ? (
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-80">
                  <span>出处：</span>
                  {(message.citations ?? []).map((citation) => (
                    <a
                      key={`${citation.sourceId}-${citation.chunkId}-${citation.sourceVersion}`}
                      className="inline-flex max-w-full items-center gap-1 underline-offset-2 hover:underline"
                      href={sourceDownloadHref(citation.sourceId, citation.sourceVersion)}
                      title={sourceViewerCopy({
                        requestedVersion: citation.sourceVersion,
                        currentVersion: currentVersions[citation.sourceId] ?? citation.sourceVersion,
                        versionMismatch: (currentVersions[citation.sourceId] ?? citation.sourceVersion) !== citation.sourceVersion,
                      })}
                    >
                      <span className="min-w-0 truncate">{citation.label}</span>
                      <span
                        className={
                          message.role === "user"
                            ? "shrink-0 rounded bg-white/20 px-1 py-0.5 font-medium tabular-nums leading-none text-[0.65rem] text-white"
                            : "shrink-0 rounded bg-zinc-200 px-1 py-0.5 font-medium tabular-nums leading-none text-[0.65rem] text-zinc-700"
                        }
                      >
                        {`v${citation.sourceVersion}`}
                      </span>
                    </a>
                  ))}
                </p>
              ) : null}
              {message.status === "pending" ? (
                <p className="mt-1 text-xs opacity-70">生成中…</p>
              ) : null}
              {message.status === "outcome_unknown" ? (
                <p className="mt-1 text-xs text-amber-700">结果状态未知，请勿重复提交</p>
              ) : null}
              {message.status === "failed" ? (
                <p className="mt-1 text-xs text-red-600">本轮失败</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
