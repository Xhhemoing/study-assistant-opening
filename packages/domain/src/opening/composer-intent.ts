import {
  hasRecordReadDemand, resolveComposerPurpose,
  type ComposerPurpose, type QueryHistory, type StudyIntentEvent, type TutorMode,
} from "@aistudy/contracts";
import { studyIntentForMessage } from "./study-intent-instruction";

/** The learning UI carries background separately from the learner's actual request. */
export function composerMessageText(text: string): string {
  if (text.startsWith("【从学习界面带入的提问背景；")) {
    const marker = "\n\n我的问题：\n", index = text.lastIndexOf(marker);
    if (index >= 0) return text.slice(index + marker.length).trim();
  }
  return text.trim();
}

function requestText(text: string): string {
  return composerMessageText(text).normalize("NFKC")
    .replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|(?:^|\s)'[^'\n]*'/g, " ")
    .replace(/^\s*>.*$/gm, " ").trim();
}

function requestClauses(text: string): string[] {
  return text.split(/[，,。.!！?？;；\n]/u).map(clause => clause.trim()
    .replace(/^(?:(?:请|麻烦|先|能否|能不能|可不可以|可以|帮我|替我|为我|我想|我要|我需要)\s*)+/u, "")
    .replace(/^(?:please\s+|can\s+you\s+|could\s+you\s+)+/i, ""))
    .filter(Boolean);
}

function recordRequestText(text: string): string {
  return text.split(/([，,。.!！?？;；\n]+)/u).map(part =>
    requestClauses(part).some(clause => /^(?:不要|别|不需要|不用|不必|无需|不想|不是要|不是想)/.test(clause)) ? "" : part,
  ).join("");
}

function requestedMode(clauses: readonly string[]): TutorMode | undefined {
  for (const clause of [...clauses].reverse()) {
    if (/^(?:只(?:给|要)(?:我)?(?:一点|一个|些)?提示|给(?:我)?(?:一点|一个|些)?提示|提示(?:一下|我)?|不要(?:直接)?(?:给(?:我)?)?(?:答案|完整(?:解答|答案|讲解)|解题过程)|别(?:直接)?(?:给(?:我)?)?(?:答案|完整解答))/.test(clause)
      || /^(?:(?:just|only)\s+(?:give\s+me\s+)?(?:a\s+)?hint|(?:give\s+me\s+)?a\s+hint|don['’]t\s+(?:give|show)\s+(?:me\s+)?(?:the\s+)?answer)\b/i.test(clause)) return "hint";
    if (/^(?:(?:直接)?给(?:我)?(?:出)?(?:完整)?(?:答案|解答|解法|解题过程)|告诉我(?:答案|解法)|(?:完整|详细)?(?:讲解|解释|讲讲|说明)|(?:不要|别)只给(?:我)?提示|直接给关键步骤|只(?:要|讲|给)(?:我)?关键步骤)/.test(clause)
      || /^(?:explain\b|(?:give|show)\s+me\s+(?:the\s+)?(?:full\s+)?(?:answer|solution)\b)/i.test(clause)) return "explain";
    if (/^(?:先听我(?:讲|说)|让我先(?:讲|说)|听我(?:讲|说))/.test(clause)) return "listen";
    if (/^(?:和我|陪我|一起)(?:想|思考|分析)/.test(clause)) return "think_together";
  }
  return undefined;
}

function requestedPurpose(clauses: readonly string[]): ComposerPurpose {
  for (const clause of clauses) {
    if (/^(?:(?:制定|规划|安排|生成|创建|新建|做|调整|修改|更新).{0,80}(?:学习计划|复习计划|备考计划|计划|日程)|给我(?:一份|一个|个|份)?.{0,60}(?:学习|复习|备考)计划)/.test(clause)
      || /^(?:make|create|plan|schedule)\s+(?:(?:me|a|my|the)\s+){0,3}(?:study|revision|learning)\s+(?:plan|schedule)\b/i.test(clause)) return "plan";
    if (/^(?:(?:创建|新建|生成|开始)(?:一节|一个|一次|一堂|个|节)?(?:关于)?.{0,60}(?:课程|课|教学活动)|带我(?:开始|学习)|教我学习)/.test(clause)
      || /^(?:start|create)\s+(?:a\s+)?(?:lesson|course)\b/i.test(clause)) return "teach";
  }
  return "answer";
}

export type ComposerIntentInput = {
  text: string;
  /** Supplied values are deliberate overrides, never inferred UI defaults. */
  mode?: TutorMode;
  purpose?: ComposerPurpose;
  querySystem?: boolean;
  history?: QueryHistory;
  practiceMode?: boolean;
  defaultMode?: TutorMode;
  studyIntent?: Pick<StudyIntentEvent, "intent" | "action"> | null;
};

/** Small request rules select an existing route; they never grant read or write authority. */
export function inferComposerIntent(input: ComposerIntentInput): {
  mode: TutorMode; purpose: ComposerPurpose; querySystem: boolean;
} {
  const text = requestText(input.text), clauses = requestClauses(text);
  resolveComposerPurpose(input); // Preserve the existing explicit-purpose conflict rule.
  const selectedPurpose = input.purpose ?? (input.querySystem ? "query" : requestedPurpose(clauses));
  const history = input.history?.map(turn => {
    const question = requestText(turn.text);
    // Keep the turn boundary: a proposal request ends any earlier record-query chain.
    return { ...turn, text: requestedPurpose(requestClauses(question)) === "answer" ? recordRequestText(question) : "" };
  });
  const querySystem = ["query", "explain_state"].includes(selectedPurpose)
    || selectedPurpose === "answer" && hasRecordReadDemand(recordRequestText(text), history);
  const purpose = querySystem ? selectedPurpose === "explain_state" ? "explain_state" : "query" : selectedPurpose;
  const intent = studyIntentForMessage(input.studyIntent, composerMessageText(input.text));
  const explicitStyle = intent?.intent.explanationStyle;
  const mode = input.mode ?? requestedMode(clauses)
    ?? (explicitStyle === "full" || explicitStyle === "key_steps" ? "explain" : undefined)
    ?? input.defaultMode ?? (input.practiceMode ? "hint" : "explain");
  return { mode, purpose, querySystem };
}
