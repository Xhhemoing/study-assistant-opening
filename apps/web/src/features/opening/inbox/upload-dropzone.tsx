"use client";

import { Files, LoaderCircle, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { ui } from "../design/ui";
import { resolveUploadMime } from "./upload-state";

export const openingUploadAccept = ".pdf,.ppt,.pptx,.html,.htm,.md,.markdown,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav";

const typeLabels: Record<string, string> = {
  ".pdf": "PDF", ".ppt": "PPT", ".pptx": "PPTX", ".html": "HTML", ".htm": "HTML",
  ".md": "Markdown", ".markdown": "Markdown", ".png": "PNG", ".jpg": "JPG", ".jpeg": "JPEG",
  ".webp": "WebP", ".mp3": "MP3", ".m4a": "M4A", ".wav": "WAV",
};

export function supportedUploadTypesLabel(accept: string): string {
  const labels = accept.split(",").map(token => token.trim().toLowerCase()).filter(Boolean).map(token => {
    if (typeLabels[token]) return typeLabels[token];
    if (token.endsWith("/*")) return token.slice(0, -2).toUpperCase();
    return token.toUpperCase();
  });
  return [...new Set(labels)].join("、") || "所有文件";
}

export function isAcceptedUploadFile(file: Pick<File, "name" | "type">, accept: string): boolean {
  const tokens = accept.split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  if (mime) {
    return tokens.some(token => {
      if (token.endsWith("/*")) return mime.startsWith(`${token.slice(0, -1)}`);
      if (token.startsWith(".")) return resolveUploadMime({ name: `file${token}`, type: "" }) === mime;
      return mime === token;
    });
  }
  const resolved = resolveUploadMime({ name, type: "" });
  return tokens.some(token => token.startsWith(".") ? name.endsWith(token) : token.endsWith("/*") ? resolved?.startsWith(token.slice(0, -1)) : resolved === token);
}

type Props = {
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
  capture?: "environment" | "user";
  onFiles: (files: File[]) => void;
};

function filesFromList(list: FileList | null): File[] {
  return list ? Array.from(list) : [];
}

export function UploadDropzone({ disabled = false, multiple = true, accept = openingUploadAccept, capture, onFiles }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }

  function handleFiles(files: File[]) {
    if (disabled || !files.length) return;
    const accepted = files.filter(file => isAcceptedUploadFile(file, accept));
    const rejected = files.filter(file => !isAcceptedUploadFile(file, accept));
    setRejection(rejected.length ? `不支持的文件类型：${rejected.map(file => file.name).join("、")}。支持类型：${supportedUploadTypesLabel(accept)}` : null);
    if (accepted.length) onFiles(multiple ? accepted : accepted.slice(0, 1));
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    handleFiles(filesFromList(event.target.files));
    event.target.value = "";
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    handleFiles(filesFromList(event.dataTransfer.files));
  }

  return (
    <div className="space-y-2">
      <div
        aria-disabled={disabled}
        aria-label="上传材料"
        className={`group rounded-xl border-2 border-dashed px-4 py-5 text-center transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none ${
          disabled
            ? "cursor-not-allowed border-zinc-200 bg-zinc-50 opacity-60"
            : dragging
              ? "cursor-copy border-emerald-600 bg-emerald-50 shadow-sm shadow-emerald-900/10"
              : "cursor-pointer border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50"
        }`}
        onClick={openPicker}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={disabled ? -1 : 0}
      >
        <div className="mx-auto flex max-w-lg items-center justify-center gap-2 text-sm font-medium text-zinc-900">
          {disabled ? <LoaderCircle className="size-4 animate-spin text-zinc-500 motion-reduce:animate-none" aria-hidden /> : dragging ? <Files className="size-4 text-emerald-700" aria-hidden /> : <Upload className="size-4 text-zinc-600" aria-hidden />}
          {disabled ? "当前正在上传" : dragging ? "松开鼠标即可添加材料" : "拖入文件到这里，或点击选择"}
        </div>
        <p className="mt-1 text-xs leading-5 text-zinc-500">支持类型：{supportedUploadTypesLabel(accept)}，可一次添加多个文件。</p>
        <span className={`${ui.secondary} pointer-events-none mt-3 inline-flex`}>选择文件</span>
      </div>
      {rejection ? <p className="text-xs text-rose-700" role="alert">{rejection}</p> : null}
      <input
        ref={inputRef}
        accept={accept}
        capture={capture}
        className="sr-only"
        disabled={disabled}
        multiple={multiple}
        onChange={onChange}
        type="file"
      />
    </div>
  );
}
