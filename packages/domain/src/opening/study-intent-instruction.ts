import type { StudyIntentEvent, StudySessionIntent } from "@aistudy/contracts";
import { applyExplicitStudyIntent, DEFAULT_STUDY_SESSION_INTENT } from "./span-teaching";

/** Composer text is a command only when the whole short utterance consists of explicit commands/self-reports. */
export function parseExplicitStudyMessage(current: StudySessionIntent, message: string) {
  message = message.replace(/^(?:关于\s*)?(?:span|线性组合|张成空间)[\s，,:：]+/i, "");
  if (message.length > 500 || /["'“”‘’「」『』`]|为什么|是什么意思|怎么|如何|能否|是否|如果|例如|比如|假如/.test(message)) return null;
  const remainder = message.replace(/(?:不要|别|不想|不需要|不必|无需|不打算|不是要|不是想|并非要)(?:英文|中文|双语|快速|加快|讲慢|串讲|拔高|自学|复习|冲刺|先学|关键步骤|完整讲解)|(?:没有|没|不是|并非)(?:抄(?:了)?答案|猜的|蒙的)|用英文(?:讲解)?|英文讲解|用中文(?:讲解)?|中文讲解|双语(?:讲解)?|中英对照|快速(?:讲解)?|快一点|加快(?:节奏)?|慢一点|讲慢(?:一点)?|慢慢(?:讲)?|直接给关键步骤|只(?:要|讲|给)(?:我)?关键步骤|完整讲解|详细讲(?:解)?|连续推进|继续往下|一直讲|一步一步等我|每步等我|不要连续|我(?:很累|累了)|有点累|(?:我只有|我有|时间预算(?:是|为)?|限时)\s*\d+\s*分钟|我不懂|看不懂|没看懂|完全不会|一点也不会|从零开始|先从基础学|先学|先巩固|先探路|先保持|我(?:是猜的|猜的|蒙的)|抄了答案|抄的答案|照着答案|串讲|拔高|自学|复习|冲刺/g, "");
  if (!/^(?:请|麻烦|现在|这轮|接下来|给我|帮我|我想|我要|我需要|一下|吧|谢谢|还是|或者|或是|[\s，,。.!！?？;；、:：])*$/u.test(remainder)) return null;
  return applyExplicitStudyIntent(current, message);
}

/** The actual current message can override old preferences only through the strict explicit parser. */
export function studyIntentForMessage(event: Pick<StudyIntentEvent, "intent" | "action"> | null | undefined, message: string) {
  const current = event?.intent ?? DEFAULT_STUDY_SESSION_INTENT;
  const applied = parseExplicitStudyMessage(current, message);
  if (!applied) return event ?? null;
  const changed = (Object.keys(applied.intent) as Array<keyof typeof current>).some(key => applied.intent[key] !== current[key]);
  if (!changed && !applied.signals.length && !applied.needsConfirmation) return event ?? null;
  return { intent: applied.intent, action: applied.needsConfirmation ? "clarify_intent" as const
    : applied.signals.includes("confused") ? "diagnose" as const : applied.signals.includes("too_easy") ? "increase_challenge" as const : "continue" as const };
}

/** Only validated server intent enums enter the prompt; event free text never becomes a system instruction. */
export function studyIntentInstruction(event: Pick<StudyIntentEvent, "intent" | "action"> | null | undefined): string {
  if (!event) return "";
  const intent = event.intent;
  const language = { zh: "使用中文讲解，保留必要的原文术语。", en: "Use English for this explanation; keep mathematical notation unchanged.", bilingual: "使用中英双语对照讲解，数学符号保持一致。" }[intent.language];
  const pace = { slow: "放慢节奏，每次只处理一个小步骤并核对理解。", normal: "按正常节奏组织清楚的小段落。", fast: "加快节奏，省去重复铺垫，表达简洁。" }[intent.pace];
  const purpose = { confused: "当前目的：先定位不懂之处，用一个简短问题诊断，再继续。", self_study: "当前目的：自学，围绕本题与当前学习目标推进。", overview: "当前目的：串讲，说明概念之间的联系；不要把单题正确等同整体掌握。", challenge: "当前目的：提高挑战，使用需要解释或检验的新问题。", review: "当前目的：复习，先检查可独立完成的部分。", exam_sprint: "当前目的：考前复习，围绕已确认考试范围与时间安排表达。" }[intent.purpose];
  const style = intent.explanationStyle === "key_steps" ? "只给关键步骤，不展开完整推导；仍遵守当前题的帮助限制。"
    : intent.explanationStyle === "full" ? "在当前允许的帮助范围内完整讲解，不跳过必要理由。" : "";
  const continuation = intent.continuous ? "观察到本步目标表现后可以提出下一小步；不替学生提交作答或自动接受计划。" : "每次一小步后停下，等待学生回应，不自行连续推进。";
  const fatigue = intent.selfReportedFatigue === "high" ? "学生自报疲劳较高，缩短本轮内容并允许暂停；这不是能力或认知负荷测量。" : "";
  const clarification = event.action === "clarify_intent" ? "本次目的变更尚不明确：保留下面已确认偏好，先澄清，不擅自换教学模式。" : "";
  const phase = intent.learningPhase ? ({ explore: "阶段：探路，先用短诊断定位目标。", new_learning: "阶段：新学，先给一个现成示例，再逐步放手。", consolidate: "阶段：巩固，先让学生作答，再逐步减少帮助。", maintain: "阶段：保持，仅在合法到期复测中使用复测题。" }[intent.learningPhase]) : "";
  return `\n\n本轮已确认的会话呈现偏好：明确偏好优先于历史推测与默认模板，仅改变表达和教学策略，不改变正确性、证据资格、隐私规则或独立作答的帮助边界。\n${[clarification, language, pace, style, purpose, phase, continuation, `本轮时间预算：${intent.timeBudgetMinutes}分钟。`, fatigue].filter(Boolean).join("\n")}`;
}
