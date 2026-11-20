export const providers = {
  doubao: "豆包", chatgpt: "ChatGPT", claude: "Claude", kimi: "Kimi", deepseek: "DeepSeek", other: "其他",
} as const;
export type Provider = keyof typeof providers;

function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu,
      char => char === "\n" || char === "\t" ? char : "")
    .replace(/\p{Cs}/gu, "\ufffd")
    .trim();
}

const stepMarker = /^(?:[-*+]\s+|\d{1,3}(?:[)、]|\.(?!\d))\s*|(?:步骤\s*[一二三四五六七八九十\d]+|第[一二三四五六七八九十\d]+步|step\s+\d+)\s*[:：.、]?\s*)/i;

export function extractKeySteps(content: string, summary = ""): string[] {
  const body = clean(content);
  if (!body) return [];
  const explicit = clean(summary);
  const structured: string[] = [];
  const prose: string[] = [];
  let fence = "";
  for (const raw of (explicit || body).split("\n")) {
    const line = raw.trim();
    const marker = /^(~{3,}|`{3,})/.exec(line)?.[0];
    if (marker && !fence) { fence = marker; continue; }
    if (fence) {
      if (line.startsWith(fence)) fence = "";
      continue;
    }
    const unheaded = line.replace(/^#{1,6}\s+/, "").replace(/^\*\*(.+?)\*\*/, "$1");
    if (!explicit && /^#{1,6}\s+/.test(line) && !stepMarker.test(unheaded)) continue;
    const step = unheaded.replace(stepMarker, "").replace(/^\*\*(.*?)\*\*$/, "$1").trim();
    if (!step) continue;
    const list = explicit || stepMarker.test(unheaded) ? structured : prose;
    if (list.length < 3 && !list.includes(step)) list.push(step);
    if (structured.length === 3) break;
  }
  if (structured.length) return structured;
  return prose.length ? prose : ["用自己的话说明这段讲解的思路"];
}

export function prepareCapture(input: { content: string; title?: string; providerHint?: Provider; keyStepSummary?: string }) {
  const content = clean(input.content);
  const firstLine = content.split("\n", 1)[0] ?? "";
  const label = clean(input.title ?? "") || firstLine.replace(/^#{1,6}\s+/, "");
  const title = Array.from(label.replace(/[\\/:*?"<>|]/g, " ").replace(/\.{2,}/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, 80).join("").replace(/[.\s]+$/, "") || "外部讲解";
  const summary = clean(input.keyStepSummary ?? "");
  const keySteps = extractKeySteps(content, summary);
  const sections = [content];
  if (summary) sections.push("## 我的关键步骤\n\n" + summary);
  if (input.providerHint) sections.push("讲解来源：" + providers[input.providerHint]);
  const normalizedInput = [clean(input.title ?? ""), content, summary, input.providerHint ?? null];
  return { normalizedInput, content, title, name: title + ".md", markdown: sections.join("\n\n") + "\n", keySteps };
}
