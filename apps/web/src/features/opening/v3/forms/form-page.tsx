import type { FormEvent, ReactNode } from "react";
import { ui } from "@aistudy/ui";
import { ArrowLeft } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";

type FormPageProps = {
  title: string;
  backHref: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel: string;
  submitting?: boolean;
  /** 表单级错误（服务端返回），放在操作条上方 */
  error?: string;
  children: ReactNode;
};

/**
 * T8 表单任务页（新建课程、考试设置、上传资料）：返回 + 标题、prose 宽度表单、底部固定操作条。
 * 动效：字段组错开进入；错误上浮出现；提交中按钮文字切换，不禁用整页。
 */
export function FormPage({ title, backHref, onSubmit, submitLabel, submitting = false, error, children }: FormPageProps) {
  return (
    <form onSubmit={onSubmit} className="flex h-full flex-col" noValidate>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2 md:px-4">
        <TransitionLink href={backHref} direction="back" aria-label="返回" className={ui.icon}><ArrowLeft size={18} aria-hidden="true" /></TransitionLink>
        <h1 className="text-[17px] font-semibold text-text">{title}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-6"><div className="content-grid motion-safe:stagger">{children}</div></div>
      <footer className="shrink-0 border-t border-line bg-surface px-4 py-2 pb-[calc(8px+env(safe-area-inset-bottom))] md:px-8">
        <div className="mx-auto flex max-w-(--layout-prose) items-center justify-end gap-2">
          {error && <p role="alert" className="mr-auto text-[13px] text-danger motion-safe:animate-enter">{error}</p>}
          <TransitionLink href={backHref} direction="back" className={ui.quiet}>取消</TransitionLink>
          <button type="submit" disabled={submitting} className={ui.primary}>{submitting ? "正在保存…" : submitLabel}</button>
        </div>
      </footer>
    </form>
  );
}
