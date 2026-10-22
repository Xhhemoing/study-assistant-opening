import type { FormEvent, ReactNode } from "react";
import { ui } from "../ui/controls";
import { ArrowLeft } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";
import { TopBar } from "../shell/top-bar";

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
    <form onSubmit={onSubmit} data-scroll-root className="flex h-full flex-col overflow-y-auto [scrollbar-gutter:stable]" noValidate>
      <TopBar leading={<TransitionLink href={backHref} direction="back" aria-label="返回" className={ui.icon}><ArrowLeft size={18} aria-hidden="true" /></TransitionLink>} title={title} collapsedTitle />
      <div className="content-grid flex-1 pb-6 pt-1 motion-safe:stagger"><h1 className="text-display font-semibold text-text">{title}</h1>{children}</div>
      <footer className="sticky bottom-0 z-10 px-3 pb-[calc(12px+env(safe-area-inset-bottom))] pt-2">
        <div className="mx-auto flex max-w-(--layout-prose) items-center justify-end gap-2 rounded-pill glass p-1.5 pl-4">
          {error && <p role="alert" className="mr-auto text-meta text-danger motion-safe:animate-enter">{error}</p>}
          <TransitionLink href={backHref} direction="back" className={ui.quiet}>取消</TransitionLink>
          <button type="submit" disabled={submitting} className={ui.primary}>{submitting ? "正在保存…" : submitLabel}</button>
        </div>
      </footer>
    </form>
  );
}
