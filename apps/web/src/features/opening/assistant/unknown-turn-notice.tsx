import type { JobStatusResponse } from "@aistudy/contracts";
import { ui } from "../design/ui";

export function UnknownTurnNotice({ job, canRetry, disabled, onRetry }: {
  job: JobStatusResponse;
  canRetry: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  return <section aria-label="回答恢复" className="mx-5 mb-2 rounded-xl border border-warn/25 bg-warn-soft p-3 text-xs leading-6 text-warn">
    <p role="status">{canRetry ? "还不确定这次是否答完，可以重新提问。" : "还不确定这次是否答完，请稍等一会儿再重新提问。"}</p>
    <p className="text-warn">不会自动再问一次；这次的用量还在确认，再问一次可能产生额外费用。</p>
    <button type="button" className={`${ui.secondary} mt-2`} disabled={!canRetry || disabled} onClick={onRetry}>{canRetry ? "重新提问" : "稍后重新提问"}</button>
    <p className="mt-1 text-warn">会把问题放回输入框，由你决定是否发送。</p>
    {job.error?.message ? <details className="mt-1"><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">查看原因</summary><p className="break-words">{job.error.message}</p></details> : null}
  </section>;
}
