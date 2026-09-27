"use client";

import { useEffect, useState } from "react";
import { AssistantView } from "./assistant-view";
import { sendDraft, setCourseDraft, setDraft, setMode, simulateDownload, submitCourse, toggleCitation, openCourse, openCourseCreate, backToCourses, launchCourseAssistant } from "./chat-actions";
import { advanceUpload, closeUpload, openUpload, pickUploadName, selectMaterial, setPage, toggleMaterials } from "./material-actions";
import { initialPreviewState, type PreviewScene, type PreviewView } from "./model";
import { applyHash, goTo, hashFor, newConversation, openContinue, selectConversation, setScene } from "./session-actions";
import { CoursesView } from "./courses-view";
import { PreviewShell } from "./shell";
import { TodayView } from "./today-view";
import { UploadSheet } from "./upload-sheet";

const TITLES = { today: "今日", assistant: "助理", courses: "课程" } as const;

export function OpeningPreviewApp() {
  const [state, setState] = useState(initialPreviewState);
  useEffect(() => {
    const sync = () => setState((current) => applyHash(current, window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    const next = hashFor(state);
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [state]);
  const update = (view: PreviewView) => setState((current) => goTo(current, view));
  const scene = (value: PreviewScene) => setState((current) => setScene(current, value));
  return (
    <PreviewShell onScene={scene} onView={update} state={state} title={TITLES[state.view]}>
      {state.view === "today" ? (
        <TodayView onAsk={() => setState((current) => newConversation(current))} onContinue={() => setState(openContinue)} onRetry={() => scene("normal")} onUpload={() => setState(openUpload)} state={state} />
      ) : null}
      {state.view === "assistant" ? (
        <AssistantView
          onCitation={(id) => setState((current) => toggleCitation(current, id))}
          onDownload={() => setState(simulateDownload)}
          onDraft={(draft) => setState((current) => setDraft(current, draft))}
          onMode={(mode) => setState((current) => setMode(current, mode))}
          onNew={() => setState((current) => newConversation(current))}
          onPage={(page) => setState((current) => setPage(current, page))}
          onRetry={() => scene("normal")}
          onSelectConversation={(id) => setState((current) => selectConversation(current, id))}
          onSelectMaterial={(id) => setState((current) => selectMaterial(current, id))}
          onSend={() => setState(sendDraft)}
          onToggleMaterials={() => setState(toggleMaterials)}
          state={state}
        />
      ) : null}
      {state.view === "courses" ? (
        <CoursesView onBack={() => setState(backToCourses)} onCreate={() => setState(openCourseCreate)} onDraft={(patch) => setState((current) => setCourseDraft(current, patch))} onLaunch={() => setState(launchCourseAssistant)} onOpen={(id) => setState((current) => openCourse(current, id))} onRetry={() => scene("normal")} onSubmit={() => setState(submitCourse)} state={state} />
      ) : null}
      <UploadSheet onAdvance={() => setState(advanceUpload)} onClose={() => setState(closeUpload)} onPick={(name) => setState((current) => pickUploadName(current, name))} state={state} />
    </PreviewShell>
  );
}
