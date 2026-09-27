"use client";

import { useEffect, useRef } from "react";
import { PrimaryButton, QuietButton } from "./shell";
import type { PreviewState } from "./model";

export function UploadSheet(props: { state: PreviewState; onClose: () => void; onPick: (name: string) => void; onAdvance: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.state.uploadOpen) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener.current?.focus();
    };
  }, [props.state.uploadOpen, props.onClose]);
  if (!props.state.uploadOpen) return null;
  const progress = props.state.uploadProgress;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-zinc-950/40 sm:items-center">
      <div aria-labelledby="upload-title" aria-modal="true" className="w-full max-w-md rounded-t-lg bg-white p-4 shadow-lg sm:rounded-lg" role="dialog">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold" id="upload-title">上传材料</h2>
          <button className="min-h-11 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={props.onClose} ref={closeRef} type="button">关闭</button>
        </div>
        <p className="mt-1 text-sm text-zinc-600">只记住文件名。预览不会读取内容，也不会上传。</p>
        <label className="mt-4 flex min-h-11 cursor-pointer items-center justify-center rounded-md ring-1 ring-zinc-300 text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-500">
          选择文件
          <input
            accept=".pdf,.ppt,.pptx,application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onPick(file.name);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        {props.state.uploadName ? <p className="mt-3 truncate text-sm" role="status">已选择 {props.state.uploadName}</p> : null}
        {progress !== null ? (
          <div className="mt-3">
            <div aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress} className="h-2 overflow-hidden rounded-full bg-zinc-200" role="progressbar">
              <div className={`h-full bg-indigo-600 ${progress >= 100 ? "w-full" : progress >= 70 ? "w-2/3" : "w-1/3"}`} />
            </div>
            <p className="mt-1 text-xs text-zinc-600">模拟接收 {progress}% · 不是真实传输</p>
          </div>
        ) : null}
        <div className="mt-4 flex gap-2">
          <PrimaryButton disabled={progress === null} onClick={props.onAdvance}>{progress !== null && progress >= 70 ? "完成模拟" : "继续模拟"}</PrimaryButton>
          <QuietButton onClick={props.onClose}>取消</QuietButton>
        </div>
      </div>
    </div>
  );
}
