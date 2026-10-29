/** Derived structural evidence only. No cell values or inferred facts leave this layer. */
export function dataProfile(block) {
  const d = block.data;
  if (block.type === 'table') {
    const total = d.rows.length * d.columns.length;
    const missing = d.rows.reduce((n, row) => n + row.filter(v => v === null || v === '').length, 0);
    const categories = d.columns.map((c, i) => ({c, i})).filter(x => x.c.kind === 'nominal');
    const measures = d.columns.map((c, i) => ({c, i})).filter(x => x.c.kind === 'quantitative');
    return {rows: d.rows.length, columns: d.columns.length,
      missingRatio: total ? Math.round(missing / total * 100) / 100 : 0,
      duplicateLabels: categories.length === 1 && measures.length > 0 && new Set(d.rows.map(r => r[categories[0].i])).size !== d.rows.length,
      numericColumns: measures.length,
      varyingMeasures: measures.filter(({i}) => new Set(d.rows.map(r => r[i]).filter(v => typeof v === 'number')).size > 1).length};
  }
  if (block.type === 'chart') return {rows: d.rows.length,
    duplicateLabels: new Set(d.rows.map(r => r.label)).size !== d.rows.length,
    constant: new Set(d.rows.map(r => r.value)).size <= 1, missingRatio: 0};
  if (block.type === 'plot') return {rows: d.points.length,
    missingRatio: Math.round(d.points.filter(p => p.x === null || p.y === null).length / Math.max(1, d.points.length) * 100) / 100,
    constant: new Set(d.points.map(p => p.y).filter(v => typeof v === 'number')).size <= 1};
  return {};
}
export function qualityNotes(candidate) {
  const p = dataProfile(candidate.block), notes = [];
  if (p.missingRatio >= 0.3) notes.push('缺失数据较多，保留缺口；数据表更便于核对');
  if (p.duplicateLabels) notes.push('分类标签重复，图形可能混淆对象');
  if(candidate.projection?.omittedKeys.length)notes.push('当前视图仅展示所选字段，其他列保留在原始数据中');
  if (p.constant) notes.push('数值没有变化，图形的额外收益有限');
  return notes;
}
