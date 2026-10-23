import type { JobStatusResponse } from "@aistudy/contracts";
import { ui } from "../design/ui";

export function UnknownTurnNotice({ job, canRetry, disabled, onRetry }: {
  job: JobStatusResponse;
  canRetry: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  return <section aria-label="回答恢复" className="mx-5 mb-2 rounded-xl border border-warn/25 bg-warn-soft p-3 text-xs leading-6 text-warn">
    <p role="status">{canRetry ? "本轮结果仍未确认，可以重新提问。" : "本轮结果尚未确认，请稍候，等待结束后可重新提问。"}</p>
    <p className="text-warn">原请求不会自动重发，费用也未确认。再次发送可能产生额外费用。</p>
    <button type="button" className={`${ui.secondary} mt-2`} disabled={!canRetry || disabled} onClick={onRetry}>{canRetry ? "重新提问" : "稍后重新提问"}</button>
    <p className="mt-1 text-warn">只把原问题带回输入框，由你确认后发送。</p>
    {job.error?.message ? <details className="mt-1"><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">查看本轮原因</summary><p className="break-words">{job.error.message}</p></details> : null}
  </section>;
}
