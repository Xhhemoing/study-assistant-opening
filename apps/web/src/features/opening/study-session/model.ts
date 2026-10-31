export type StudyStep =
  | { kind: "learn"; id: string; title: string; body: string; estimateMinutes: number | null }
  | { kind: "question"; id: string; title: string; prompt: string; answerModes: ("text" | "photo")[]; hintsAvailable: number; estimateMinutes: number | null; attemptRef: { id: string; itemVersionId: string | null }; fields: AnswerField[] };
export type AnswerField = { key: string; label: string; options?: { value: string; label: string }[] };
export type HelpState = { level: "none" | "hinted" | "revealed"; hintsShown: number; tutorAsked: boolean; texts: string[]; canRequest: boolean };
export type StepResult = { outcome: "correct" | "incorrect" | "pending" | "needs_manual" | "unknown"; assistance: "independent" | "hinted" | "revealed" | "unknown"; reasonCode?: string };
export type PhotoWorkSource = { id: string; version: number; physicalPage: number };
export type PhotoState = { enabled: boolean; status: "none" | "uploading" | "preparing" | "ready" | "pending" | "unavailable" | "failed"; name?: string; workSource?: PhotoWorkSource; message?: string };
export type NextAction = { action: string; label: string; estimateMinutes: number | null; reasonCode: string | null; alternatives: { action: string; label: string }[] };
export type StudySessionView = { step: StudyStep; help: HelpState; result: StepResult | null; next: NextAction | null; answer: Record<string, string>; locked: boolean; photo?: PhotoState };
export type StudySessionPort = {
  load: () => Promise<StudySessionView>;
  edit: (key: string, value: string) => StudySessionView;
  choosePhoto: (file: File) => Promise<StudySessionView>;
  removePhoto: () => StudySessionView;
  primary: () => Promise<StudySessionView>;
  help: () => Promise<StudySessionView>;
  pause: () => Promise<void>;
  navigate: (action: string) => void;
};
const resultLabels: Record<StepResult["outcome"], Record<StepResult["assistance"], string>> = {
  correct: { independent: "独立答对", hinted: "用提示后答对", revealed: "看过解答后完成", unknown: "本题答对，帮助情况待确认" },
  incorrect: { independent: "还没对，再看看思路", hinted: "还没对，再看看思路", revealed: "还没对，再看看思路", unknown: "还没对，再看看思路" },
  pending: { independent: "正在核对答案", hinted: "正在核对答案", revealed: "正在核对答案", unknown: "正在核对答案" },
  needs_manual: { independent: "答案已保存，需要人工核对", hinted: "答案已保存，需要人工核对", revealed: "答案已保存，需要人工核对", unknown: "答案已保存，需要人工核对" },
  unknown: { independent: "答案已保存，结果待确认", hinted: "答案已保存，结果待确认", revealed: "答案已保存，结果待确认", unknown: "答案已保存，结果待确认" },
};
export const resultLabel = (result: StepResult) => resultLabels[result.outcome][result.assistance];
export const reasonLabels: Record<string, string> = { evidence_changed: "作答记录已变化，请核对最新安排。", source_unavailable: "先恢复课程材料，再继续学习。", unknown_evidence: "先确认这次作答，再选择下一步。" };
