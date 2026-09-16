"use client";

import type { ChatMessageView } from "./message-model";

type Props = {
  messages: ChatMessageView[];
  historyTruncated?: boolean;
};

export function MessageList({ messages, historyTruncated }: Props) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3" role="log" aria-live="polite">
      {historyTruncated ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          更早的对话已截断；当前为服务端组装的有界历史。
        </p>
      ) : null}
      {messages.length === 0 ? (
        <p className="text-sm text-zinc-500">还没有消息。上传并指定材料后即可提问。</p>
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
              {message.citationLabels.length > 0 ? (
                <p className="mt-2 text-xs opacity-80">
                  出处：{message.citationLabels.join(" · ")}
                </p>
              ) : null}
              {message.status === "pending" ? (
                <p className="mt-1 text-xs opacity-70">生成中…</p>
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
