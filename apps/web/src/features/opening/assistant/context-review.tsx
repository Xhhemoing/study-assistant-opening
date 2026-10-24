import type { ReactNode } from "react";
import type { StudyConversationContext } from "./study-conversation-context";

export type ContextReviewProps = {
  studyContext?: StudyConversationContext;
  courseLabel?: string;
  courseBound: boolean;
  taskLabel?: string;
  attemptBound: boolean;
  selectedSourceCount: number;
  materialMode: "auto" | "selected" | "none";
  privacy: "saved" | "ephemeral";
  returnHref: string | null;
  embedded?: boolean;
  diagnostics?: boolean;
  children?: ReactNode;
};

/** Read-only review of current inputs, not a receipt of retrieved or verified evidence. */
export function ContextReview({ studyContext: context, courseLabel, courseBound, taskLabel, attemptBound,
  selectedSourceCount, materialMode, privacy, returnHref, embedded, diagnostics, children }: ContextReviewProps) {
  const questionBound = attemptBound || Boolean(context?.attemptId);
  return <section aria-label="上下文审阅" className="shrink-0 border-b border-line px-4 py-2 text-xs leading-5 text-text-2 sm:px-5">
    {children}
    <details>
      <summary className="min-h-9 cursor-pointer py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">本轮背景 · {questionBound ? "原题与作答已绑定" : context?.label || taskLabel || (courseBound ? courseLabel || "已绑定课程" : "自由提问")} · {selectedSourceCount} 份所选资料</summary>
      <div className="max-h-64 space-y-2 overflow-y-auto pb-2">
    <div className="space-y-1" aria-label="固定学习身份">
      <p className="font-medium text-text">{questionBound ? "题目绑定" : "学习身份"}</p>
      <p>课程：{courseBound ? courseLabel || "已绑定的课程" : "未绑定课程 · 普通对话"}</p>
      {taskLabel ? <p>任务：{taskLabel}</p> : null}
      {context ? <>
        <p>提问背景：{context.label || (context.activityId ? "当前学习单元" : context.sourceId ? "指定材料" : "已绑定的课程")}{context.page ? ` · 第 ${context.page} 页` : ""}</p>
        {context.contentVersion !== undefined ? <p>学习内容版本：{context.contentVersion}</p> : null}
        {context.sourceId ? <p>材料版本：{context.sourceVersion ?? "提交时当前版本"}</p> : null}
        {context.itemVersionId ? <p>题目版本：已绑定原题版本</p> : null}
        <p>{context.activityId || context.fragment ? "背景将在你发送时作为文字附上；资料依据仍以回答中的真实引用为准。" : context.sourceId ? "已指定参考材料和位置；回答中的实际引用用于核对依据。" : "继续先前绑定的课程提问；导航不会自动更换这段对话的课程。"}</p>
      </> : null}
      {questionBound ? <p>本对话固定绑定原题与作答；资料选择不会解除题目绑定，也不会自动完成练习。</p> : courseBound || taskLabel || context?.activityId || context?.sourceId ? <p>这里仅审阅学习身份；更改资料选择不会清除课程、任务或原内容绑定。</p> : null}
      {returnHref && !embedded ? <a href={returnHref} className="text-accent underline">返回原内容</a> : null}
    </div>
    {context?.fragment ? <div aria-label="用户携入片段">
      <p>用户携入片段：发送时作为文字背景携入，并非已核对的引文，也不表示已经掌握。</p>
      <details><summary className="min-h-9 cursor-pointer py-2 focus-visible:ring-2 focus-visible:ring-focus-ring">展开完整片段</summary><p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-line-strong pl-2">{context.fragment}</p></details>
    </div> : null}
    <div aria-label="资料与历史范围">
      <p>已选资料：{selectedSourceCount} 份 · {materialMode === "none" ? "不用资料" : materialMode === "auto" ? "自动参考本课资料" : "仅用所选资料"}</p>
      <p>{materialMode === "none" ? "本轮不检索资料，也不自动补入课程材料；不用资料不等于清空历史或携入文字。" : materialMode === "auto" ? courseBound ? "自动查找本课程可读资料；已选数量不代表实际检索或引用数量。" : "未绑定课程，不会自动补入课程资料。" : "只检索所选资料；尚未选择时不能发送。所选资料不等于已核对依据。"}</p>
      <p>{privacy === "ephemeral" ? "临时对话不接续已保存历史；仅使用本标签页临时消息、当前输入与所选背景，刷新后不会恢复。" : "已有对话文字仍可能包含先前讨论的内容；资料选择不会清除已保存历史。"}</p>
      <p>实际资料引用仍在各条回答中查看和核对。</p>
    </div>
    {diagnostics && context ? <dl aria-label="提问背景诊断" className="break-all">
      {context.courseId ? <><dt>课程</dt><dd>{context.courseId}</dd></> : null}
      {context.activityId ? <><dt>活动 / 内容版本</dt><dd>{context.activityId} / {context.contentVersion ?? "未指定"}</dd></> : null}
      {context.blockId ? <><dt>学习单元</dt><dd>{context.blockId}</dd></> : null}
      {context.sourceId ? <><dt>材料 / 版本</dt><dd>{context.sourceId} / {context.sourceVersion ?? "提交时当前版本"}</dd></> : null}
      {context.attemptId ? <><dt>题目作答</dt><dd>{context.attemptId}</dd></> : null}
      {context.itemVersionId ? <><dt>题目版本</dt><dd>{context.itemVersionId}</dd></> : null}
    </dl> : null}
      </div>
    </details>
  </section>;
}
