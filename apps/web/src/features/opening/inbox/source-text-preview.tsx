"use client";

import { useEffect, useState } from "react";

/** Fetches same-origin inline bytes and shows plain/markdown text. */
export function SourceTextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setText(null);
    setError("");
    void fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`预览读取失败 (${response.status})`);
        return response.text();
      })
      .then((value) => {
        if (active) setText(value);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "预览失败");
      });
    return () => {
      active = false;
    };
  }, [url]);

  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (text == null) return <p role="status" className="text-sm text-zinc-500">正在加载预览…</p>;
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border border-zinc-200 bg-zinc-50 px-3 py-3 font-sans text-sm leading-6 text-zinc-800">
      {text}
    </pre>
  );
}
