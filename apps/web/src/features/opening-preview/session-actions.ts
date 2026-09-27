import type { PreviewState, PreviewView, SampleConversation } from "./model";
import { activeConversation, recentReadyMaterial, visibleMaterials } from "./model";

export function nextPreviewId(prefix: string, tick: number): string {
  return `${prefix}-${tick + 1}`;
}

export function replaceConversation(
  state: PreviewState,
  id: string,
  update: (item: SampleConversation) => SampleConversation,
): SampleConversation[] {
  return state.conversations.map((item) => (item.id === id ? update(item) : item));
}

export function goTo(state: PreviewState, view: PreviewView): PreviewState {
  return { ...state, view, uploadOpen: false, openCitationId: null };
}

export function setScene(state: PreviewState, scene: PreviewState["scene"]): PreviewState {
  return { ...state, scene, statusNote: null, sendPhase: "idle", openCitationId: null };
}

export function selectConversation(state: PreviewState, id: string): PreviewState {
  if (!state.conversations.some((item) => item.id === id)) return state;
  return {
    ...state,
    view: "assistant",
    activeConversationId: id,
    openCitationId: null,
    statusNote: null,
    sendPhase: "idle",
  };
}

export function newConversation(state: PreviewState, courseId: string | null = null): PreviewState {
  const created: SampleConversation = {
    id: nextPreviewId("conv", state.simulatedTick),
    title: courseId ? "课程里的新对话" : "新对话",
    courseId,
    materialId: null,
    page: "",
    messages: [],
  };
  return {
    ...state,
    view: "assistant",
    simulatedTick: state.simulatedTick + 1,
    conversations: [created, ...state.conversations],
    activeConversationId: created.id,
    openCitationId: null,
    statusNote: "已切换到新对话。材料与页码已清空，输入仍保留。",
    sendPhase: "idle",
  };
}

export function openContinue(state: PreviewState): PreviewState {
  const ready = recentReadyMaterial(visibleMaterials(state.scene));
  const current = activeConversation(state);
  if (!current || !ready) return { ...state, view: "assistant", materialsOpen: true };
  return selectConversation(
    {
      ...state,
      conversations: replaceConversation(state, current.id, (item) => ({ ...item, materialId: ready.id, page: "12" })),
    },
    current.id,
  );
}

export function hashFor(state: PreviewState): string {
  if (state.view !== "courses" || state.courseScreen === "list") return `#${state.view}`;
  if (state.courseScreen === "detail" && state.selectedCourseId) {
    return `#courses/detail/${state.selectedCourseId}`;
  }
  return `#courses/${state.courseScreen}`;
}

export function applyHash(state: PreviewState, hash: string): PreviewState {
  const [view, screen, id] = hash.replace(/^#/, "").split("/").filter(Boolean);
  if (view !== "today" && view !== "assistant" && view !== "courses") return state;
  if (view !== "courses") return { ...state, view };
  if (screen === "create") return { ...state, view, courseScreen: "create" };
  if (screen === "detail" && id) return { ...state, view, courseScreen: "detail", selectedCourseId: id };
  return { ...state, view, courseScreen: "list" };
}
