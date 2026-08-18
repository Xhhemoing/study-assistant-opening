"use client";

import { FileDown, FolderInput, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { BackupRestoreResponse, NativeBackupPackage } from "@aistudy/contracts";
import {
  backupCopy,
  buildBackupExportRequest,
  buildBackupRestoreRequest,
} from "./backup-menu-model";

type Pending = "export" | "restore" | null;

export function BackupMenu() {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState("");
  const [policy, setPolicy] = useState<"reject" | "skip">("reject");
  const [result, setResult] = useState<BackupRestoreResponse | null>(null);
  const copy = backupCopy(result?.warnings.length ?? 0);

  async function runExport() {
    setPending("export");
    setError("");
    try {
      const response = await fetch("/api/backups/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBackupExportRequest()),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { package: NativeBackupPackage };
      downloadFile(JSON.stringify(body.package, null, 2), "aistudy-backup.json", "application/json");
    } catch {
      setError("暂时无法导出完整备份，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  async function runRestore(file: File) {
    setPending("restore");
    setError("");
    setResult(null);
    try {
      const packed = JSON.parse(await file.text()) as NativeBackupPackage;
      const response = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBackupRestoreRequest(packed, policy)),
      });
      if (!response.ok) throw new Error();
      setResult(await response.json() as BackupRestoreResponse);
    } catch {
      setError("暂时无法恢复备份。冲突记录不会被覆盖，请检查文件后重试。");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="space-y-4 border-t border-line pt-8" aria-labelledby="backup-heading">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-text" id="backup-heading">{copy.headline}</h2>
        <p className="text-sm leading-6 text-text-dim">{copy.disclaimer}</p>
        <p className="text-sm leading-6 text-text-dim">{copy.restoreHint}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending !== null}
          onClick={() => void runExport()}
          type="button"
        >
          {pending === "export" ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <FileDown aria-hidden="true" size={16} />}
          导出完整备份
        </button>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">冲突策略</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input checked={policy === "reject"} className="accent-primary" name="backup-conflict" onChange={() => setPolicy("reject")} type="radio" />
          拒绝（发现已存在 ID 时整体失败）
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input checked={policy === "skip"} className="accent-primary" name="backup-conflict" onChange={() => setPolicy("skip")} type="radio" />
          跳过（保留现有记录，不覆盖）
        </label>
      </fieldset>
      <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-within:ring-2 focus-within:ring-primary">
        {pending === "restore" ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <FolderInput aria-hidden="true" size={16} />}
        恢复备份
        <input
          accept="application/json,.json"
          className="sr-only"
          disabled={pending !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void runRestore(file);
          }}
          type="file"
        />
      </label>
      {error ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <button className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-xs text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => void runExport()} type="button">
            <RefreshCw aria-hidden="true" size={14} />重试导出
          </button>
        </div>
      ) : null}
      {result ? <p className="text-sm leading-6 text-text-dim" role="status">{copy.resultSummary}</p> : null}
    </section>
  );
}

function downloadFile(content: string, filename: string, type: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
