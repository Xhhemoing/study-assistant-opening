import {
  hasRecordReadDemand, resolveComposerPurpose,
  type ComposerPurpose, type LearningMessageIntent, type QueryHistory, type StudyIntentEvent, type TutorMode,
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

/** Only the learner's request counts: quoted material and carried context are not self-reports. */
export function inferLearningMessageIntent(message: string): LearningMessageIntent {
  const clauses = requestClauses(requestText(message));
  if (clauses.some(clause => /^(?:先)?(?:跳过(?:这(?:一|道)?题)?|换(?:一|道|个).*题|不做这(?:一|道)?题|skip(?:\s+(?:this|the)\s+(?:question|problem))?)(?:吧|了|please)?$/i.test(clause))) return "skip";
  if (clauses.some(clause => /^(?:(?:这(?:一|道)?题)?我)?(?:完全|真的|还是|一点也)?(?:不会(?:做)?|不懂|看不懂|做不出来|好烦|崩了|太难(?:了)?|想放弃|放弃(?:了)?)(?:了|啊|呀|怎么办|好烦|太难|\s)*$/.test(clause)
    || /^(?:i(?:'m| am)\s+(?:stuck|frustrated)|i\s+(?:can'?t\s+do\s+this|give\s+up)|this\s+is\s+too\s+hard)\b/i.test(clause))) return "frustrated";
  if (clauses.some(clause => /^(?:我的(?:答案|解法|思路|步骤|推导|过程)(?:是|为|如下|[:：])|我(?:算(?:出(?:来)?|得)|得到|做(?:出|到)|先|用|设|认为|选)[^。]{0,200}(?:[=＝\d]|然后|所以|因此|对吗|正确|错)|(?:我)?(?:这样算|这样做|这样解)(?:对吗|可以吗))/.test(clause)
    || /^(?:my\s+(?:answer|solution|work)\s+is|i\s+(?:got|calculated|tried))\b/i.test(clause))) return "submit_attempt";
  if (clauses.some(clause => /^(?:这一步|下一步|刚才这一步)/.test(clause))) return "solve";
  if (clauses.some(clause => /^(?:什么是|何为|为什么|为何|解释.{0,60}(?:概念|定义|意思)|.{1,40}(?:是什么|为什么|是什么意思))/.test(clause)
    || /^(?:what\s+(?:is|are)|why\b|define\b)/i.test(clause)) && !requestsFinalAnswer(message)) return "concept";
  if (requestsFinalAnswer(message) || clauses.some(clause => /^(?:求(?:解|出|证|值|导|积|\s|[a-zA-Z(（])|计算|证明|解(?:答|出|方程|一下|\s|[a-zA-Z(（])|已知|设[\s\u4e00-\u9fffA-Za-z])/.test(clause)
    || /这(?:一|道)?题|题干|答案是|(?:怎么|如何)(?:解|做|算|求|证明)/.test(clause)
    || /^(?:solve|calculate|prove|evaluate|find\s+the)\b/i.test(clause))) return "solve";
  return "general";
}

export function requestsFinalAnswer(message: string): boolean {
  return requestClauses(requestText(message)).some(clause => !/是什么意思|有什么含义/.test(clause) && !/^(?:不要|别|不需要|不用|不必|无需|不想|不是)/.test(clause)
    && (/^(?:(?:这(?:一|道)?题|刚才(?:的)?这(?:一|道)?题|还是|再|直接)\s*)*(?:(?:给|告诉|展示)(?:我)?(?:出)?(?:完整)?(?:答案|解答|解法|解题过程)|(?:这(?:一|道)?题(?:的)?)?答案(?:是什么|是多少)|(?:完整|直接)(?:讲解|讲完整)(?:这(?:一|道)?题))/.test(clause)
      || /^(?:(?:give|show)\s+me\s+(?:the\s+)?(?:full\s+)?(?:answer|solution)|what\s+is\s+the\s+answer)\b/i.test(clause)));
}

function cleanAnswerRequest(text: string): string {
  return requestText(text).replace(/[\s，,。.!！?？;；]/g, "");
}

function isShortAnswerFollowup(text: string): boolean {
  return /^(?:(?:请|还是|再|直接|给我|告诉我|完整|的|刚才|这道题|这题|答案|解答|解法|讲解|讲完整|吧|谢谢|是什么|是多少))+$/.test(cleanAnswerRequest(text));
}

/** A new problem does not inherit a previous request's escape hatch. Only an immediate repeat/follow-up does. */
export function repeatsAnswerRequest(text: string, history: QueryHistory = []): boolean {
  if (!requestsFinalAnswer(text)) return false;
  const prior = history.filter(turn => turn.role === "user").at(-1);
  if (!prior || !requestsFinalAnswer(prior.text)) return false;
  if (cleanAnswerRequest(text) === cleanAnswerRequest(prior.text)) return true;
  // A short follow-up without a new stem, number, or formula can refer to the immediately preceding problem.
  return isShortAnswerFollowup(text);
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
  const learning = inferLearningMessageIntent(input.text);
  const requested = requestedMode(clauses);
  const answerRequest = requestsFinalAnswer(input.text);
  const confirmedStyle = explicitStyle === "full" || explicitStyle === "key_steps";
  const prior = input.history?.filter(turn => turn.role === "user").at(-1);
  const hasPriorAttempt = prior && inferLearningMessageIntent(prior.text) === "submit_attempt" && isShortAnswerFollowup(input.text);
  const firstAnswerRequest = answerRequest && requested !== "hint" && !confirmedStyle
    && learning !== "submit_attempt" && !hasPriorAttempt && !repeatsAnswerRequest(input.text, input.history);
  const mode = input.mode ?? (requested === "hint" ? "hint" : undefined)
    ?? (learning === "frustrated" || learning === "skip" ? "listen" : undefined)
    ?? (firstAnswerRequest ? "hint" : answerRequest ? "explain" : requested)
    ?? (explicitStyle === "full" || explicitStyle === "key_steps" ? "explain" : undefined)
    ?? (learning === "submit_attempt" || learning === "solve" ? "hint" : learning === "concept" ? "explain" : undefined)
    ?? input.defaultMode ?? (input.practiceMode ? "hint" : "explain");
  return { mode, purpose, querySystem };
}
