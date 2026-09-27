"use client";

import { FileText } from "lucide-react";
import { PrimaryButton, QuietButton, SceneNote } from "./shell";
import { continueContext, type PreviewState } from "./model";
import { allMaterials } from "./material-actions";
import { STATUS_LABEL, statusClass } from "./icons";

export function TodayView(props: { state: PreviewState; onContinue: () => void; onAsk: () => void; onUpload: () => void; onRetry: () => void }) {
  const context = continueContext();
  const materials = allMaterials(props.state).slice(0, 3);
  const blocked = props.state.scene === "loading" || props.state.scene === "error";
  return (
    <section className="max-w-2xl">
      <SceneNote error="示例今日内容没有读出来。已有入口仍可使用。" loading="正在读取示例今日内容…" onRetry={props.onRetry} scene={props.state.scene} />
      {blocked ? null : (
        <>
          <p className="text-sm leading-6 text-zinc-600">从上次停下的位置继续，或直接开始一个问题。</p>
          <div className="mt-5">
            {props.state.scene === "empty" ? (
              <PrimaryButton onClick={props.onAsk}>开始提问</PrimaryButton>
            ) : (
              <PrimaryButton onClick={props.onContinue}>继续 {context.course} · {context.topic}</PrimaryButton>
            )}
            <div className="mt-3">
              <QuietButton onClick={props.onUpload}>上传材料</QuietButton>
            </div>
            {props.state.scene === "normal" ? <p className="mt-3 text-sm text-zinc-600">{context.place} · 上次对话「极限的直观理解」</p> : null}
          </div>
          <h2 className="mt-8 text-sm font-semibold text-zinc-800">最近材料</h2>
          {materials.length === 0 ? <p className="mt-2 text-sm text-zinc-600">还没有示例材料。上传只会留下文件名。</p> : (
            <ul className="mt-2 divide-y divide-zinc-200 border-y border-zinc-200">
              {materials.map((item) => (
                <li className="flex items-center gap-3 py-3" key={item.id}>
                  <FileText aria-hidden="true" className="shrink-0 text-zinc-500" size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block text-xs text-zinc-500">{item.detail}</span>
                  </span>
                  <span className={`rounded-full px-2 py-1 text-xs ring-1 ${statusClass(item.status)}`}>{STATUS_LABEL[item.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
