"use client";

import { Camera, Upload } from "lucide-react";
import { useId, useState, type ChangeEvent } from "react";
import { resolveUploadMime } from "./upload-state";
import { ui } from "../design/ui";

type Props = {
  disabled?: boolean;
  onFile: (file: File) => void;
};

export function CaptureDialog({ disabled, onFile }: Props) {
  const inputId = useId();
  const [warning, setWarning] = useState("");

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!resolveUploadMime({ name: file.name, type: file.type })) {
      setWarning("不支持这个格式。不会改名，也不会创建材料。");
      return;
    }
    setWarning("");
    onFile(file);
  }

  return (
    <div className="space-y-2">
      <label
        className={`${ui.primary} cursor-pointer ${disabled ? "pointer-events-none opacity-50" : ""}`}
        htmlFor={inputId}
      >
        <Camera aria-hidden size={16} />
        <Upload aria-hidden size={16} />
        选择文件或拍照
      </label>
      <input
        accept="image/*,.pdf,.ppt,.pptx,.html,.htm,.md,.markdown,audio/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        id={inputId}
        onChange={onChange}
        type="file"
      />
      {warning ? (
        <p className="text-sm text-amber-800" role="status">{warning}</p>
      ) : (
        <p className="text-xs text-zinc-600">上传进度只统计已发送字节，不代表服务器解析进度。</p>
      )}
    </div>
  );
}
