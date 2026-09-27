import type { PreviewState, SampleMaterial } from "./model";
import { SAMPLE_MATERIALS, activeConversation, selectableMaterialIds } from "./model";
import { nextPreviewId, replaceConversation } from "./session-actions";

export function allMaterials(state: Pick<PreviewState, "scene" | "extraMaterials">): SampleMaterial[] {
  return state.scene === "empty" ? [] : [...SAMPLE_MATERIALS, ...state.extraMaterials];
}

export function toggleMaterials(state: PreviewState): PreviewState {
  return { ...state, materialsOpen: !state.materialsOpen };
}

export function selectMaterial(state: PreviewState, materialId: string | null): PreviewState {
  const current = activeConversation(state);
  if (!current) return state;
  if (materialId && !selectableMaterialIds(allMaterials(state)).includes(materialId)) {
    return { ...state, statusNote: "只有已可阅读的示例材料可以选中。" };
  }
  return {
    ...state,
    statusNote: null,
    conversations: replaceConversation(state, current.id, (item) => ({
      ...item,
      materialId,
      page: materialId ? item.page || "12" : "",
    })),
  };
}

export function setPage(state: PreviewState, page: string): PreviewState {
  const current = activeConversation(state);
  if (!current?.materialId) return state;
  return {
    ...state,
    conversations: replaceConversation(state, current.id, (item) => ({
      ...item,
      page: page.replace(/[^\d]/g, "").slice(0, 4),
    })),
  };
}

export function openUpload(state: PreviewState): PreviewState {
  return { ...state, uploadOpen: true, view: state.view === "courses" ? "assistant" : state.view };
}

export function closeUpload(state: PreviewState): PreviewState {
  return { ...state, uploadOpen: false, uploadProgress: null };
}

export function pickUploadName(state: PreviewState, name: string): PreviewState {
  const uploadName = name.trim();
  if (!uploadName) return state;
  return { ...state, uploadName, uploadProgress: 35, statusNote: null };
}

export function advanceUpload(state: PreviewState): PreviewState {
  if (!state.uploadName || state.uploadProgress === null) return state;
  const uploadProgress = Math.min(100, state.uploadProgress + 35);
  if (uploadProgress < 100) return { ...state, uploadProgress };
  const material: SampleMaterial = {
    id: nextPreviewId("file", state.simulatedTick),
    title: state.uploadName,
    detail: "刚刚选择 · 仅保存在这次预览内存",
    status: "processing",
  };
  return {
    ...state,
    simulatedTick: state.simulatedTick + 1,
    extraMaterials: [...state.extraMaterials, material],
    uploadOpen: false,
    uploadProgress: null,
    uploadName: null,
    materialsOpen: true,
    view: "assistant",
    statusNote: `已模拟接收「${material.title}」。预览不会读取或发送文件内容。`,
  };
}
