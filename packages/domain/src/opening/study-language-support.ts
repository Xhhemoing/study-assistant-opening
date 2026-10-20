/** Deterministic language scaffolding only. No model output can certify its own support domain. */
export function makeStudyLanguageSupport(canonicalQuestion: string | null = null): string {
  const glossary = "固定术语对照：vector＝向量；span＝线性张成；linear combination＝线性组合；coefficient＝系数；coordinate＝坐标；matrix＝矩阵；row＝行；column＝列；consistent＝相容；inconsistent＝不相容。";
  return canonicalQuestion
    ? `以下仅转述已确认题目的题意，并提供术语对照；不包含建模、解题步骤或答案。\n\n${canonicalQuestion}\n\n${glossary}`
    : `当前只能提供固定术语对照，尚未核实自由材料的完整题意，因此这里不是全文翻译；不包含建模、解题步骤或答案。\n\n${glossary}`;
}
