/** Small offline retrieval ablation. No embeddings/provider requests or production query rewriting. */
export const STUDY_RETRIEVAL_CORPUS = [
  { id: "linear-span", text: "linear span 线性张成 生成子空间" },
  { id: "independence", text: "linear independence 线性无关 向量独立" },
  { id: "rank", text: "matrix rank 矩阵的秩" },
  { id: "retention", text: "delayed retention check 延迟复测 保持检查" },
  { id: "help", text: "assistance exposure 帮助曝光 提示记录" },
] as const;
export const STUDY_RETRIEVAL_CASES = [
  { query: "linear span", expected: "linear-span", group: "english" },
  { query: "linear independence", expected: "independence", group: "english" },
  { query: "matrix rank", expected: "rank", group: "english" },
  { query: "线性张成", expected: "linear-span", group: "chinese_alias" },
  { query: "生成子空间", expected: "linear-span", group: "chinese_alias" },
  { query: "向量独立", expected: "independence", group: "chinese_alias" },
  { query: "向量组能生成什么空间", expected: "linear-span", group: "synonym" },
  { query: "过几天再测是否记得", expected: "retention", group: "synonym" },
  { query: "看过多少提示", expected: "help", group: "synonym" },
] as const;
const aliases: Record<string, string> = { "向量组能生成什么空间": "linear span", "过几天再测是否记得": "delayed retention check", "看过多少提示": "assistance exposure" };
export function evaluateStudyRetrieval(mode: "literal" | "curated_alias") {
  const cases = STUDY_RETRIEVAL_CASES.map(test => {
    const query = mode === "curated_alias" ? aliases[test.query] ?? test.query : test.query;
    const matches = STUDY_RETRIEVAL_CORPUS.filter(document => document.text.toLowerCase().includes(query.toLowerCase()));
    return { ...test, retrieved: matches.map(document => document.id), hit: matches.some(document => document.id === test.expected) };
  });
  return { mode, total: cases.length, hits: cases.filter(test => test.hit).length, cases };
}
