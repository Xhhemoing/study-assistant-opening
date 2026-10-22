"use client";

import { Files, LoaderCircle, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { ui } from "../design/ui";
import { openingUploadAccept, supportedUploadTypesLabel, uploadBatchRejection, uploadFileRejection } from "./upload-preflight";

export { openingUploadAccept, supportedUploadTypesLabel, isAcceptedUploadFile, uploadFileRejection } from "./upload-preflight";

type Props = {
  compact?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
  capture?: "environment" | "user";
  onFiles: (files: File[]) => void;
};

function filesFromList(list: FileList | null): File[] {
  return list ? Array.from(list) : [];
}

export function UploadDropzone({ compact = false, disabled = false, multiple = true, accept = openingUploadAccept, capture, onFiles }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }

  function handleFiles(files: File[]) {
    if (disabled || !files.length) return;
    const batchRejection = uploadBatchRejection(multiple ? files : files.slice(0, 1));
    if (batchRejection) { setRejection(batchRejection); return; }
    const checked = files.map(file => ({ file, rejection: uploadFileRejection(file, accept) }));
    const accepted = checked.filter(item => item.rejection === null).map(item => item.file);
    const rejected = checked.flatMap(item => item.rejection ? [item.rejection] : []);
    setRejection(rejected.length ? rejected.join(" ") : null);
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
        aria-label={compact ? "添加资料" : "上传材料"}
        title={compact ? `可拖入文件，或点击添加。支持类型：${supportedUploadTypesLabel(accept)}` : undefined}
        className={`group ${compact ? "inline-flex min-h-10 items-center rounded-lg border px-3 py-2" : "rounded-xl border-2 border-dashed px-4 py-5 text-center"} transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none ${
          disabled
            ? "cursor-not-allowed border-line bg-bg opacity-60"
            : dragging
              ? "cursor-copy border-accent bg-accent-soft shadow-sm shadow-emerald-900/10"
              : "cursor-pointer border-line-strong bg-surface hover:border-line-strong hover:bg-bg"
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
        <div className="mx-auto flex max-w-lg items-center justify-center gap-2 text-sm font-medium text-text">
          {disabled ? <LoaderCircle className="size-4 animate-spin text-text-2 motion-reduce:animate-none" aria-hidden /> : dragging ? <Files className="size-4 text-accent" aria-hidden /> : <Upload className="size-4 text-text-2" aria-hidden />}
          {disabled ? "当前正在上传" : dragging ? "松开鼠标即可添加材料" : compact ? "添加资料" : "拖入文件到这里，或点击选择"}
        </div>
        {!compact ? <>
          <p className="mt-1 text-xs leading-5 text-text-2">支持类型：{supportedUploadTypesLabel(accept)}，{multiple ? "可一次添加多个文件" : "每次添加一个文件"}。</p>
          <span className={`${ui.secondary} pointer-events-none mt-3 inline-flex`}>选择文件</span>
        </> : null}
      </div>
      {rejection ? <p className="text-xs text-danger" role="alert">{rejection}</p> : null}
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
