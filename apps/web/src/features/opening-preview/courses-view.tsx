"use client";

import { PrimaryButton, QuietButton, SceneNote, TextField } from "./shell";
import type { PreviewState } from "./model";
import { allCourses } from "./chat-actions";

export function CoursesView(props: {
  state: PreviewState;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onBack: () => void;
  onDraft: (patch: Partial<PreviewState["courseDraft"]>) => void;
  onSubmit: () => void;
  onLaunch: () => void;
  onRetry: () => void;
}) {
  const courses = allCourses(props.state);
  const selected = courses.find((item) => item.id === props.state.selectedCourseId) ?? knownCourse(props.state.selectedCourseId);
  if (props.state.courseScreen === "create") {
    return (
      <form className="max-w-lg space-y-4" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
        <TextField label="课程名称" onChange={(title) => props.onDraft({ title })} value={props.state.courseDraft.title} />
        <TextField label="学期" onChange={(term) => props.onDraft({ term })} value={props.state.courseDraft.term} />
        {props.state.courseError ? <p className="text-sm text-rose-700" role="alert">{props.state.courseError}</p> : null}
        <div className="flex gap-2">
          <PrimaryButton onClick={props.onSubmit}>保存示例课程</PrimaryButton>
          <QuietButton onClick={props.onBack}>返回</QuietButton>
        </div>
      </form>
    );
  }
  if (props.state.courseScreen === "detail" && selected) {
    const talks = props.state.conversations.filter((item) => item.courseId === selected.id);
    return (
      <section className="max-w-2xl">
        <QuietButton onClick={props.onBack}>返回课程</QuietButton>
        <h2 className="mt-4 text-base font-semibold">{selected.title}</h2>
        <p className="mt-1 text-sm text-zinc-600">{selected.term} · 示例课程，不会写入课程库</p>
        <div className="mt-4"><PrimaryButton onClick={props.onLaunch}>用这门课开始提问</PrimaryButton></div>
        <h3 className="mt-6 text-sm font-semibold">这门课的对话</h3>
        {talks.length === 0 ? <p className="mt-2 text-sm text-zinc-600">还没有挂在这门课上的对话。</p> : (
          <ul className="mt-2 divide-y divide-zinc-200">{talks.map((item) => <li className="py-2 text-sm" key={item.id}>{item.title}</li>)}</ul>
        )}
      </section>
    );
  }
  return (
    <section>
      <SceneNote error="示例课程没有读出来。" loading="正在读取示例课程…" onRetry={props.onRetry} scene={props.state.scene} />
      {props.state.scene === "loading" || props.state.scene === "error" ? null : (
        <>
          <PrimaryButton onClick={props.onCreate}>新建课程</PrimaryButton>
          {courses.length === 0 ? <p className="mt-4 text-sm text-zinc-600">还没有示例课程。</p> : (
            <ul className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200">
              {courses.map((item) => (
                <li key={item.id}>
                  <button className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={() => props.onOpen(item.id)} type="button">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{item.term}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function knownCourse(id: string | null) {
  if (id === "course-calc") return { id, title: "高等数学", term: "2026 春" };
  if (id === "course-linear") return { id, title: "线性代数", term: "2026 春" };
  return null;
}
