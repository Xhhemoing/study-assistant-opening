"use client";

import { useEffect, useState } from "react";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
        if (active) setError(userFacingMessage(reason, "预览失败"));
      });
    return () => {
      active = false;
    };
  }, [url]);

  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (text == null) return <p role="status" className="text-sm text-text-3">正在加载预览…</p>;
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border border-line bg-bg px-3 py-3 font-sans text-sm leading-6 text-text">
      {text}
    </pre>
  );
}
