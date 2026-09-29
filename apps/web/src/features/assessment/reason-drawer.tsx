"use client";

import { ui } from "../opening/design/ui";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { StatusResult } from "@aistudy/contracts";
import { Drawer } from "@aistudy/ui";
import { reasonCodeLabel } from "../practice/result-summary-model";

export function ReasonDrawer({
  open,
  onClose,
  onCorrection,
  status,
}: {
  open: boolean;
  onClose: () => void;
  onCorrection: (note: string) => Promise<void>;
  status: StatusResult | null;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setNote("");
      setError("");
      setSaving(false);
    }
  }, [open]);

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!note.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onCorrection(note.trim());
      onClose();
    } catch {
      setError("纠正记录保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  const reasons = status?.reasonCodes.slice(0, 3) ?? ["insufficient-evidence"];
  const actions = status?.recommendedActions.slice(0, 3) ?? [];
  return <Drawer open={open} onClose={onClose} title="为什么"><div className="grid gap-6">
    <section className="space-y-3" aria-labelledby="reason-drawer-why"><h3 className="text-sm font-semibold text-zinc-900" id="reason-drawer-why">为什么</h3><ul className="grid gap-2">{reasons.map((reason) => <li className="rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm leading-7 text-zinc-900" key={reason}>{reasonCodeLabel(reason)}</li>)}</ul></section>
    <section className="space-y-3 border-t border-zinc-200 pt-5" aria-labelledby="reason-drawer-improve"><h3 className="text-sm font-semibold text-zinc-900" id="reason-drawer-improve">怎么改善</h3>{actions.length > 0 ? <ul className="grid gap-2">{actions.map((action) => <li className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 px-3 py-2 text-sm" key={action.code}><span className="text-zinc-900">{action.label}</span><span className="shrink-0 text-xs text-zinc-500">约 {action.estimatedMinutes} 分钟</span></li>)}</ul> : <p className="text-sm text-zinc-500">先完成一项短练习，系统会继续收集证据。</p>}</section>
    <section className="space-y-3 border-t border-zinc-200 pt-5" aria-labelledby="reason-drawer-correction"><div><h3 className="text-sm font-semibold text-zinc-900" id="reason-drawer-correction">其他操作</h3><p className="mt-1 text-xs leading-5 text-zinc-500">如果这个判断不符合你的实际情况，可以留下纠正说明。</p></div><form className="grid gap-3" onSubmit={submitCorrection}><label className="grid gap-2"><span className="sr-only">纠正说明</span><textarea className="min-h-24 w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-7 text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60" disabled={saving} onChange={(event) => setNote(event.target.value)} placeholder="记录你认为不准确的地方" value={note} /></label>{error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}<button className={ui.primary} disabled={!note.trim() || saving} type="submit">{saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} /> : <Check aria-hidden="true" size={16} />}判断不准</button></form></section>
  </div></Drawer>;
}
