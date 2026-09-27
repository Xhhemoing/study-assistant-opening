import type { PreviewState, SampleCourse } from "./model";
import { MODE_OPTIONS, SAMPLE_COURSES, activeConversation } from "./model";
import { newConversation, nextPreviewId } from "./session-actions";

export function sendDraft(state: PreviewState): PreviewState {
  const text = state.draft.trim();
  const current = activeConversation(state);
  if (!text || !current || state.scene === "loading") return state;
  if (state.scene === "error") {
    return { ...state, sendPhase: "failed", statusNote: "模拟发送失败。草稿仍在输入框里，没有生成回复。" };
  }
  const mode = MODE_OPTIONS.find((item) => item.value === state.mode)?.label ?? "完整解释";
  const reply = `（示例）${mode}：围绕「${text.slice(0, 42)}」先对齐第 ${current.page || "未指定"} 页的说法，再展开。这不是真实模型结果。`;
  return {
    ...state,
    simulatedTick: state.simulatedTick + 2,
    draft: "",
    sendPhase: "idle",
    statusNote: "示例回复已显示。预览没有调用 AI。",
    conversations: state.conversations.map((item) =>
      item.id === current.id
        ? {
            ...item,
            messages: [
              ...item.messages,
              { id: nextPreviewId("user", state.simulatedTick), role: "user", text },
              {
                id: nextPreviewId("reply", state.simulatedTick + 1),
                role: "assistant",
                text: reply,
                citationId: current.materialId ? "cite-live" : undefined,
              },
            ],
          }
        : item,
    ),
  };
}

export function toggleCitation(state: PreviewState, citationId: string | null): PreviewState {
  return { ...state, openCitationId: state.openCitationId === citationId ? null : citationId };
}

export function simulateDownload(state: PreviewState): PreviewState {
  return { ...state, statusNote: "已模拟下载原件。预览没有生成文件，也没有访问网络。" };
}

export function setDraft(state: PreviewState, draft: string): PreviewState {
  return { ...state, draft };
}

export function setMode(state: PreviewState, mode: PreviewState["mode"]): PreviewState {
  return { ...state, mode };
}

export function allCourses(state: Pick<PreviewState, "scene" | "extraCourses">): SampleCourse[] {
  return state.scene === "empty" ? [] : [...SAMPLE_COURSES, ...state.extraCourses];
}

export function openCourseCreate(state: PreviewState): PreviewState {
  return { ...state, view: "courses", courseScreen: "create", courseError: null };
}

export function setCourseDraft(state: PreviewState, patch: Partial<PreviewState["courseDraft"]>): PreviewState {
  return { ...state, courseDraft: { ...state.courseDraft, ...patch }, courseError: null };
}

export function submitCourse(state: PreviewState): PreviewState {
  const title = state.courseDraft.title.trim();
  if (!title) return { ...state, courseError: "请填写课程名称。表单内容会保留。" };
  if (state.scene === "error") return { ...state, courseError: "模拟保存失败。名称和学期仍在表单里。" };
  const created = {
    id: nextPreviewId("course", state.simulatedTick),
    title,
    term: state.courseDraft.term.trim() || "未填写学期",
  };
  return {
    ...state,
    simulatedTick: state.simulatedTick + 1,
    extraCourses: [...state.extraCourses, created],
    courseScreen: "detail",
    selectedCourseId: created.id,
    courseDraft: { title: "", term: "" },
    courseError: null,
    statusNote: "示例课程只存在于这次预览，不会写入课程库。",
  };
}

export function openCourse(state: PreviewState, id: string): PreviewState {
  return { ...state, view: "courses", courseScreen: "detail", selectedCourseId: id };
}

export function backToCourses(state: PreviewState): PreviewState {
  return { ...state, courseScreen: "list", selectedCourseId: null, courseError: null };
}

export function launchCourseAssistant(state: PreviewState): PreviewState {
  if (!state.selectedCourseId) return state;
  return newConversation(state, state.selectedCourseId);
}
