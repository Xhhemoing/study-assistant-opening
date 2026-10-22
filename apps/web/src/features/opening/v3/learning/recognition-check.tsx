"use client";
import { useEffect, useState } from "react";
import { ui } from "@aistudy/ui";
import { Sheet } from "../ui/sheet";
import { TextArea } from "../ui/field";
import type { PhotoItem } from "./photo-attachments";

/** 识别核对：原图与识别文字并排，可直接改；确认后再交给批改。识别错误不算学生答错。 */
export function RecognitionCheck({ open, onOpenChange, photos, recognized, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; photos: PhotoItem[]; recognized: string; onConfirm: (text: string) => void }) {
  const [text, setText] = useState(recognized);
  useEffect(() => { if (open) setText(recognized); }, [open, recognized]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="核对识别内容">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-[13px] text-text-2">原图</p>
          {photos.length ? photos.map(photo => <img key={photo.id} src={photo.url} alt={photo.name} className="w-full rounded-md border border-line object-contain" />)
            : <p className="rounded-md bg-surface-2 p-3 text-[13px] text-text-2">没有图片，只核对文字</p>}
        </div>
        <div className="space-y-2">
          <label htmlFor="recognized" className="block text-[13px] text-text-2">识别出的解答（可修改）</label>
          <TextArea id="recognized" rows={6} value={text} onChange={event => setText(event.target.value)} />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={ui.quiet} onClick={() => onOpenChange(false)}>稍后再说</button>
        <button type="button" className={ui.primary} onClick={() => { onConfirm(text); onOpenChange(false); }}>确认并批改</button>
      </div>
    </Sheet>
  );
}
