"use client";

import { PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import { QuietButton, SceneNote } from "./shell";
import { MODE_OPTIONS, activeConversation, type PreviewState } from "./model";
import { allCourses } from "./chat-actions";
import { allMaterials } from "./material-actions";
import { MaterialsPanel } from "./materials-panel";
import { Transcript } from "./transcript";

export function AssistantView(props: {
  state: PreviewState;
  onSelectConversation: (id: string) => void;
  onNew: () => void;
  onToggleMaterials: () => void;
  onSelectMaterial: (id: string | null) => void;
  onPage: (page: string) => void;
  onDraft: (draft: string) => void;
  onMode: (mode: PreviewState["mode"]) => void;
  onSend: () => void;
  onCitation: (id: string) => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const current = activeConversation(props.state);
  const course = allCourses(props.state).find((item) => item.id === current?.courseId);
  const material = allMaterials(props.state).find((item) => item.id === current?.materialId);
  const chatScene = props.state.scene === "empty" ? "normal" : props.state.scene;
  return (
    <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-4">
      <aside className="mb-4 lg:mb-0">
        <button className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-medium text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={props.onNew} type="button">
          <Plus aria-hidden="true" size={16} />新对话
        </button>
        <ul aria-label="对话" className="mt-2 max-h-28 space-y-1 overflow-auto lg:max-h-[28rem]">
          {props.state.conversations.map((item) => (
            <li key={item.id}>
              <button aria-current={item.id === current?.id ? "true" : undefined} className={`min-h-11 w-full truncate rounded-md px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${item.id === current?.id ? "bg-white font-medium ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-white"}`} onClick={() => props.onSelectConversation(item.id)} type="button">{item.title}</button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-h-[28rem] min-w-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm text-zinc-600">{course ? course.title : "自由交流"}{material ? ` · ${material.title}` : " · 未选材料"}{current?.page ? ` · 第 ${current.page} 页` : ""}</p>
          <QuietButton onClick={props.onToggleMaterials} pressed={props.state.materialsOpen}>
            {props.state.materialsOpen ? <PanelRightClose aria-hidden="true" size={16} /> : <PanelRightOpen aria-hidden="true" size={16} />}
            <span className="ml-1">材料</span>
          </QuietButton>
        </div>
        <SceneNote error="示例对话没有读出来。输入会保留，可稍后再试。" loading="正在读取示例对话…" onRetry={props.onRetry} scene={chatScene} />
        {chatScene === "loading" ? null : (
          <div className={props.state.materialsOpen ? "lg:grid lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-4" : ""}>
            <div className="flex min-w-0 flex-col">
              <Transcript messages={current?.messages ?? []} onCitation={props.onCitation} onDownload={props.onDownload} openCitationId={props.state.openCitationId} />
              <label className="mt-3 block text-xs font-medium text-zinc-600" htmlFor="tutor-mode">回答方式</label>
              <select className="mt-1 min-h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" id="tutor-mode" onChange={(event) => props.onMode(event.target.value as PreviewState["mode"])} value={props.state.mode}>
                {MODE_OPTIONS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
              <div className="sticky bottom-20 z-10 mt-3 bg-zinc-50 pb-1 lg:static">
                <label className="sr-only" htmlFor="draft">问题</label>
                <textarea className="min-h-24 w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" id="draft" onChange={(event) => props.onDraft(event.target.value)} placeholder="直接提问，或先选定可阅读的材料" value={props.state.draft} />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p aria-live="polite" className="text-xs text-zinc-600" role="status">{props.state.statusNote ?? (props.state.sendPhase === "failed" ? "发送没有成功" : "示例发送不会调用 AI")}</p>
                  <button className="inline-flex min-h-11 items-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-zinc-300" disabled={!props.state.draft.trim()} onClick={props.onSend} type="button">发送</button>
                </div>
              </div>
            </div>
            {props.state.materialsOpen ? <MaterialsPanel onPage={props.onPage} onSelect={props.onSelectMaterial} state={props.state} /> : null}
          </div>
        )}
      </section>
    </div>
  );
}
