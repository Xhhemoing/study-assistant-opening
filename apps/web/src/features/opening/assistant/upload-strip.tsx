"use client";

import { LoaderCircle, Upload } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { resolveUploadPutUrl, type OpeningApi } from "../client/api";
import { resolveUploadMime } from "../inbox/upload-state";

type Props = {
  api: OpeningApi;
  onUploaded: () => void | Promise<void>;
  disabled?: boolean;
};

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mimeOf(file: File): ReturnType<typeof resolveUploadMime> {
  return resolveUploadMime({ name: file.name, type: file.type });
}

export function UploadStrip({ api, onUploaded, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const mime = mimeOf(file);
    if (!mime) {
      setMessage("不支持这个格式。请使用 PDF、PPT、PPTX、HTML、Markdown、PNG、JPEG 或 WEBP。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const buffer = await file.arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      const ticket = await api.beginUpload({
        name: file.name.slice(0, 180),
        mime,
        bytes: file.size,
        sha256,
      });
      const putUrl = resolveUploadPutUrl(ticket);
      const put = await fetch(putUrl, {
        method: "PUT",
        headers: { "content-type": mime },
        body: buffer,
      });
      if (!put.ok) {
        throw new Error(`上传对象失败 (${put.status})`);
      }
      await api.completeUpload(ticket.source.id);
      setMessage(`已上传：${ticket.source.name}`);
      await onUploaded();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm">
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Upload className="h-4 w-4" aria-hidden />
        )}
        上传材料
        <input
          type="file"
          className="sr-only"
          disabled={disabled || busy}
          onChange={onChange}
          accept=".pdf,.ppt,.pptx,.html,.htm,.md,.markdown,.png,.jpg,.jpeg,.webp,audio/*"
        />
      </label>
      {message ? <span className="text-xs text-zinc-600">{message}</span> : null}
    </div>
  );
}
