"use client";

import type { ReactNode } from "react";
import { NAV } from "./icons";
import type { PreviewScene, PreviewState, PreviewView } from "./model";

const SCENES: { id: PreviewScene; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "empty", label: "空" },
  { id: "loading", label: "加载" },
  { id: "error", label: "失败" },
];

const field =
  "min-h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500";

export function PrimaryButton(props: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300"
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

export function QuietButton(props: { children: ReactNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button
      aria-pressed={props.pressed}
      className="inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

export function TextField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-medium text-zinc-800">
      {props.label}
      <input className={`${field} mt-1 w-full`} onChange={(event) => props.onChange(event.target.value)} value={props.value} />
    </label>
  );
}

export function PreviewShell(props: {
  state: PreviewState;
  title: string;
  onView: (view: PreviewView) => void;
  onScene: (scene: PreviewScene) => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950 motion-reduce:scroll-auto">
      <p className="bg-indigo-700 px-4 py-2 text-center text-sm text-white">界面预览 · 示例数据，不会保存或调用 AI</p>
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden border-r border-zinc-200 bg-white lg:block">
          <div className="px-4 py-5 text-sm font-semibold">AIstudy</div>
          <Nav onView={props.onView} state={props.state} />
        </aside>
        <div className="min-w-0 pb-24 lg:pb-0">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3 lg:px-6">
            <h1 className="text-lg font-semibold">{props.title}</h1>
            <label className="text-xs font-medium text-zinc-600">
              预览状态
              <select
                className={`${field} ml-2`}
                onChange={(event) => props.onScene(event.target.value as PreviewScene)}
                value={props.state.scene}
              >
                {SCENES.map((scene) => (
                  <option key={scene.id} value={scene.id}>{scene.label}</option>
                ))}
              </select>
            </label>
          </header>
          <div className="mx-auto w-full max-w-5xl px-4 py-5 lg:px-6">{props.children}</div>
        </div>
      </div>
      <nav aria-label="预览导航" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-zinc-200 bg-white lg:hidden">
        <Nav onView={props.onView} state={props.state} />
      </nav>
    </div>
  );
}

function Nav(props: { state: PreviewState; onView: (view: PreviewView) => void }) {
  return (
    <div className="contents lg:block lg:space-y-1 lg:px-3">
      {NAV.map((item) => {
        const active = props.state.view === item.view;
        const Icon = item.icon;
        return (
          <button
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center justify-center gap-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:w-full lg:justify-start lg:rounded-md lg:px-3 ${active ? "text-indigo-700 lg:bg-indigo-50" : "text-zinc-600"}`}
            key={item.view}
            onClick={() => props.onView(item.view)}
            type="button"
          >
            <Icon aria-hidden="true" size={18} />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function SceneNote(props: { scene: PreviewScene; loading: string; error: string; onRetry: () => void }) {
  if (props.scene === "loading") return <p className="py-8 text-sm text-zinc-600" role="status">{props.loading}</p>;
  if (props.scene === "error") {
    return (
      <div className="rounded-md bg-rose-50 px-3 py-3 text-sm text-rose-900 ring-1 ring-rose-200" role="alert">
        <p>{props.error}</p>
        <button className="mt-2 min-h-11 font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={props.onRetry} type="button">重新加载示例</button>
      </div>
    );
  }
  return null;
}
