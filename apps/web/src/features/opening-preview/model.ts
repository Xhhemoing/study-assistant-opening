export type PreviewView = "today" | "assistant" | "courses";
export type PreviewScene = "normal" | "empty" | "loading" | "error";
export type MaterialStatus = "ready" | "processing" | "failed";
export type SendPhase = "idle" | "sending" | "failed";
export type TutorMode = "hint" | "explain" | "listen" | "think_together";

export type SampleMaterial = {
  id: string;
  title: string;
  detail: string;
  status: MaterialStatus;
};

export type SampleMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citationId?: string;
};

export type SampleConversation = {
  id: string;
  title: string;
  courseId: string | null;
  materialId: string | null;
  page: string;
  messages: SampleMessage[];
};

export type SampleCourse = {
  id: string;
  title: string;
  term: string;
};

export type PreviewState = {
  view: PreviewView;
  scene: PreviewScene;
  courseScreen: "list" | "create" | "detail";
  selectedCourseId: string | null;
  courseDraft: { title: string; term: string };
  courseError: string | null;
  conversations: SampleConversation[];
  activeConversationId: string | null;
  materialsOpen: boolean;
  uploadOpen: boolean;
  uploadName: string | null;
  uploadProgress: number | null;
  draft: string;
  mode: TutorMode;
  sendPhase: SendPhase;
  statusNote: string | null;
  openCitationId: string | null;
  simulatedTick: number;
  extraMaterials: SampleMaterial[];
  extraCourses: SampleCourse[];
};

export const SAMPLE_MATERIALS: SampleMaterial[] = [
  { id: "calc-notes", title: "高等数学 · 极限与连续", detail: "课件 · 示例", status: "ready" },
  { id: "linear-slides", title: "线性代数 · 矩阵初等变换", detail: "讲义 · 示例", status: "processing" },
  { id: "physics-lab", title: "大学物理 · 实验记录", detail: "扫描件 · 示例", status: "failed" },
];

export const SAMPLE_COURSES: SampleCourse[] = [
  { id: "course-calc", title: "高等数学", term: "2026 春" },
  { id: "course-linear", title: "线性代数", term: "2026 春" },
];

export const MODE_OPTIONS: { value: TutorMode; label: string }[] = [
  { value: "hint", label: "给一点提示" },
  { value: "explain", label: "完整解释" },
  { value: "listen", label: "先听我说" },
  { value: "think_together", label: "一起想办法" },
];

const CONTINUE = {
  course: "高等数学",
  topic: "极限与连续",
  place: "课件第 12 页",
};

export function continueContext(): typeof CONTINUE {
  return CONTINUE;
}

export function initialPreviewState(): PreviewState {
  const first: SampleConversation = {
    id: "conv-limit",
    title: "极限的直观理解",
    courseId: "course-calc",
    materialId: "calc-notes",
    page: "12",
    messages: [
      { id: "m1", role: "user", text: "课件第 12 页说极限存在要左右极限相等，能用这个例子说明吗？" },
      {
        id: "m2",
        role: "assistant",
        text: "可以。第 12 页用分段函数说明：左右趋势一致时，才说这一点的极限存在。这是预览里的示例说明，不是模型回复。",
        citationId: "cite-p12",
      },
    ],
  };
  return {
    view: "today",
    scene: "normal",
    courseScreen: "list",
    selectedCourseId: null,
    courseDraft: { title: "", term: "" },
    courseError: null,
    conversations: [first],
    activeConversationId: first.id,
    materialsOpen: true,
    uploadOpen: false,
    uploadName: null,
    uploadProgress: null,
    draft: "",
    mode: "explain",
    sendPhase: "idle",
    statusNote: null,
    openCitationId: null,
    simulatedTick: 0,
    extraMaterials: [],
    extraCourses: [],
  };
}

export function visibleMaterials(scene: PreviewScene): SampleMaterial[] {
  return scene === "empty" ? [] : SAMPLE_MATERIALS;
}

export function selectableMaterialIds(materials: SampleMaterial[]): string[] {
  return materials.filter((item) => item.status === "ready").map((item) => item.id);
}

export function activeConversation(state: PreviewState): SampleConversation | null {
  return state.conversations.find((item) => item.id === state.activeConversationId) ?? null;
}

export function recentReadyMaterial(materials: SampleMaterial[]): SampleMaterial | null {
  return materials.find((item) => item.status === "ready") ?? null;
}
