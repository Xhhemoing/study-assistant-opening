"use client";

import { LoaderCircle, Upload } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import { resolveUploadPutUrl, type OpeningApi } from "../client/api";

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

function mimeOf(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/pdf";
}

export function UploadStrip({ api, onUploaded, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const buffer = await file.arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      const mime = mimeOf(file);
      const ticket = await api.beginUpload({
        name: file.name.slice(0, 180),
        mime: mime as
          | "application/pdf"
          | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          | "image/jpeg"
          | "image/png"
          | "image/webp"
          | "audio/mpeg"
          | "audio/mp4"
          | "audio/wav",
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
          accept=".pdf,.png,.jpg,.jpeg,.webp,.ppt,.pptx,audio/*"
        />
      </label>
      {message ? <span className="text-xs text-zinc-600">{message}</span> : null}
    </div>
  );
}
