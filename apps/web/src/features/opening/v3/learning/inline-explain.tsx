"use client";
import { ui } from "../ui/controls";
import { Collapse } from "../motion/collapse";
import { SaveButton, type SaveState } from "../ui/save-button";

type InlineExplainProps = {
  open: boolean;
  /** 原生课程段落锚点；PDF/照片用 SelectionAsk */
  anchorId: string;
  content: string;
  noteState: SaveState;
  onSaveNote: () => void;
  onMakeCard: () => void;
  onContinueInChat: () => void;
};

/** 段落下方的短解释：高度展开（Collapse），保存后停留原位，只有失败才保留重试。 */
export function InlineExplain({ open, anchorId, content, noteState, onSaveNote, onMakeCard, onContinueInChat }: InlineExplainProps) {
  return (
    <Collapse open={open}>
      <div data-anchor={anchorId} className="rounded-ctl border-l-2 border-ai-2 bg-surface-2 px-4 py-3">
        <p className="text-meta font-medium text-text-2">补充解释</p>
        <div className="prose-reading mt-1 text-ui">{content}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1 -ml-3">
          <SaveButton state={noteState} idleLabel="存为笔记" savedLabel="已存为笔记" onSave={onSaveNote} />
          <button type="button" className={ui.quiet} onClick={onMakeCard}>做成卡片</button>
          <button type="button" className={ui.quiet} onClick={onContinueInChat}>继续问</button>
        </div>
      </div>
    </Collapse>
  );
}
