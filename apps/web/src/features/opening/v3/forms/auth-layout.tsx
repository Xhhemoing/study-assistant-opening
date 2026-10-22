import type { ReactNode } from "react";

/**
 * T10 无壳层页面（登录、注册、开始使用）：居中窄栏、品牌一行、不显示导航。
 * 多步流程用 step 作为 key，步骤之间横向滑入（slide-in），减少动效时直接切换。
 */
export function AuthLayout({ title, step, footer, children }: { title: string; step?: { index: number; total: number }; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10 text-text">
      <div className="w-full max-w-[400px] space-y-6">
        <p className="text-[15px] font-semibold tracking-tight">AIstudy</p>
        {step && (
          <div role="progressbar" aria-label={`第 ${step.index} 步，共 ${step.total} 步`} aria-valuemin={1} aria-valuemax={step.total} aria-valuenow={step.index} className="flex gap-1">
            {Array.from({ length: step.total }, (_, i) => <span key={i} data-done={i < step.index} className="h-1 flex-1 rounded-pill bg-line transition-colors duration-(--duration-panel) data-[done=true]:bg-accent" />)}
          </div>
        )}
        <div key={step?.index ?? title} className="space-y-5 motion-safe:animate-slide-in">
          <h1 className="text-[24px] font-semibold leading-8">{title}</h1>
          {children}
        </div>
        {footer ? <div className="text-[13px] text-text-2">{footer}</div> : null}
      </div>
    </div>
  );
}
