export type DemoLessonState = {
  panel: "none" | "concept" | "deepen";
  draft: string;
  submittedAnswers: string[];
  hintVisible: boolean;
  feedbackVisible: boolean;
};

export const initialDemoLessonState: DemoLessonState = {
  panel: "none",
  draft: "",
  submittedAnswers: [],
  hintVisible: false,
  feedbackVisible: false,
};

export type DemoLessonAction =
  | { type: "preview" }
  | { type: "deepen" }
  | { type: "return" }
  | { type: "edit"; text: string }
  | { type: "hint" }
  | { type: "submit" }
  | { type: "revise" }
  | { type: "reset" };

/** Deliberately local: no real course, attempt, score or persistence identity. */
export function demoLessonReducer(state: DemoLessonState, action: DemoLessonAction): DemoLessonState {
  switch (action.type) {
    case "preview": return { ...state, panel: "concept" };
    case "deepen": return { ...state, panel: "deepen" };
    case "return": return { ...state, panel: "none" };
    case "edit": return { ...state, draft: action.text, feedbackVisible: false };
    case "hint": return { ...state, hintVisible: true };
    case "submit": {
      if (!state.draft.trim() || state.feedbackVisible) return state;
      return { ...state, submittedAnswers: [...state.submittedAnswers, state.draft], feedbackVisible: true };
    }
    case "revise": return { ...state, feedbackVisible: false };
    case "reset": return initialDemoLessonState;
  }
}
