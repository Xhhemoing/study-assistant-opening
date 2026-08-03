export interface SearchDoc {
  id: string;
  type: "document" | "exploration" | "card" | "course" | "practice";
  title: string;
  body: string;
  tags: string[];
}

export interface SearchHit {
  id: string;
  type: SearchDoc["type"];
  title: string;
  snippet: string;
  score: number;
}

const SNIPPET_LENGTH = 60;
const SNIPPET_CONTEXT = 30;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function buildSnippet(body: string, loweredBody: string, tokens: string[]): string {
  let firstIdx = -1;
  for (const token of tokens) {
    const idx = loweredBody.indexOf(token);
    if (idx !== -1) {
      firstIdx = idx;
      break;
    }
  }
  const start = firstIdx === -1 ? 0 : Math.max(0, firstIdx - SNIPPET_CONTEXT);
  return Array.from(body).slice(start, start + SNIPPET_LENGTH).join("");
}

export function rankResults(query: string, docs: SearchDoc[], limit = 20): SearchHit[] {
  const tokens = normalizeSearchText(query)
    .split(" ")
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const title = normalizeSearchText(doc.title);
    const body = normalizeSearchText(doc.body);
    const tags = doc.tags.map(normalizeSearchText);
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      if (tags.some((t) => t.includes(token))) score += 2;
      if (body.includes(token)) score += 1;
    }
    if (score === 0) continue;
    hits.push({
      id: doc.id,
      type: doc.type,
      title: doc.title,
      snippet: buildSnippet(doc.body, body, tokens),
      score,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const cmp = a.title.localeCompare(b.title, "zh-Hans-CN");
    return cmp !== 0 ? cmp : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return hits.slice(0, limit);
}
