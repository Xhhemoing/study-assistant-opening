"use client";
import { useEffect, useState } from "react";
import { ui } from "@aistudy/ui";
import { Sheet } from "../ui/sheet";
import { Field, TextArea } from "../ui/field";

export type CardDraft = { front: string; back: string; source: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: CardDraft;
  decks: string[];
  /** 调用现有卡片写入接口；reject 时保留草稿并显示失败 */
  onSave: (draft: CardDraft & { deck: string }) => Promise<void>;
};

/** 卡片草稿：先编辑预览，点「加入卡组」才保存；取消或关闭不入库。 */
export function CardDraftSheet({ open, onOpenChange, initial, decks, onSave }: Props) {
  const [front, setFront] = useState(initial.front);
  const [back, setBack] = useState(initial.back);
  const [deck, setDeck] = useState(decks[0] ?? "");
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  useEffect(() => { if (open) { setFront(initial.front); setBack(initial.back); setState("idle"); } }, [open]);

  async function save() {
    setState("saving");
    try { await onSave({ front, back, source: initial.source, deck }); onOpenChange(false); }
    catch { setState("failed"); }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="做成卡片" closeLabel="关闭，不保存">
      <div className="space-y-3">
        <Field label="问题">{({ id }) => <TextArea id={id} rows={2} value={front} onChange={e => setFront(e.target.value)} />}</Field>
        <Field label="答案">{({ id }) => <TextArea id={id} rows={3} value={back} onChange={e => setBack(e.target.value)} />}</Field>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-text-2">
          <span>来源：{initial.source}</span>
          <label className="ml-auto flex items-center gap-2 whitespace-nowrap">卡组
            <select value={deck} onChange={e => setDeck(e.target.value)} className={`${ui.input} w-auto`}>{decks.map(name => <option key={name}>{name}</option>)}</select>
          </label>
        </div>
        {state === "failed" && <p role="alert" className="text-[13px] text-danger motion-safe:animate-enter">没有保存，草稿还在，可以再试一次</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={ui.quiet} onClick={() => onOpenChange(false)}>取消</button>
          <button type="button" className={ui.primary} onClick={save} disabled={state === "saving" || !front.trim() || !back.trim()}>{state === "saving" ? "保存中…" : "加入卡组"}</button>
        </div>
      </div>
    </Sheet>
  );
}
