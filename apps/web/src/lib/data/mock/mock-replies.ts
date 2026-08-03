import type { AIRole } from "@aistudy/contracts";

export const AI_ROLE_OPTIONS = [
  { role: "retriever", label: "检索" },
  { role: "explainer", label: "讲解" },
  { role: "tutor", label: "教练" },
  { role: "challenger", label: "质疑" },
  { role: "editor", label: "编辑" },
  { role: "examiner", label: "考官" },
  { role: "collaborator", label: "协作" },
  { role: "silent", label: "静默" },
] as const satisfies ReadonlyArray<{ role: AIRole; label: string }>;

const REPLY_TEMPLATES: Record<AIRole, readonly [string, string]> = {
  retriever: [
    "我会先为{topic}整理可核对的资料线索，再标出来源之间的共识与差异。",
    "围绕{topic}，我先列出需要查证的关键词和证据入口，方便你继续追问。",
  ],
  explainer: [
    "我们先把{topic}拆成一个直观比喻、一个核心定义和一个可以验证的例子。",
    "关于{topic}，我先用最短的路径讲清楚它是什么，再补上它为什么重要。",
  ],
  tutor: [
    "我们把{topic}拆成一个可以马上尝试的小问题，你先说说第一步会怎么做。",
    "先不急着看结论，围绕{topic}我给你一个小提示，帮助你自己完成推导。",
  ],
  challenger: [
    "关于{topic}，先检查一个容易被忽略的反例：这个判断在什么条件下会失效？",
    "我先对{topic}提出一个异议，再看看你的解释能否同时覆盖这个边界情况。",
  ],
  editor: [
    "我会把{topic}整理成更清晰的结构，保留结论、依据和仍待确认的部分。",
    "围绕{topic}，我先压缩重复表达，再把关键术语和转折关系标出来。",
  ],
  examiner: [
    "关于{topic}，我先给你一道短题：请用自己的话说明判断依据，而不只复述结论。",
    "我们来检验{topic}是否真的掌握：先回答一个变式，再解释你选择这条路径的原因。",
  ],
  collaborator: [
    "我先和你一起把{topic}变成一张工作草图，下一步可以从最不确定的节点开始。",
    "围绕{topic}，我建议先确认目标和已知信息，再共同决定要查资料还是做例题。",
  ],
  silent: [
    "我先为{topic}保留一个安静的思考空间，等你准备好再继续。",
    "关于{topic}，我暂时不补充内容；你可以先写下自己的判断。",
  ],
};

export function craftMockReply(role: AIRole, content: string, count: number): string {
  const topic = content.trim().slice(0, 24) || "这个主题";
  const templates = REPLY_TEMPLATES[role];
  const template = templates[Math.abs(count) % templates.length] ?? templates[0];
  return `${template.replace("{topic}", `「${topic}」`)}（模拟回复）`;
}
