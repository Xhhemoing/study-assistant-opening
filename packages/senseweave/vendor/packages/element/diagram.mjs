/** Internal SVG geometry shared by the real renderer. Coordinates are node centres. */
export function diagramShape(n) {
  const attrs = {fill: 'var(--sw-soft)', stroke: 'var(--sw-node-line)'};
  if (n.shape === 'diamond') return {tag: 'polygon', attrs: {...attrs, points: `${n.x},${n.y - 28} ${n.x + 76},${n.y} ${n.x},${n.y + 28} ${n.x - 76},${n.y}`}};
  return {tag: 'rect', attrs: {...attrs, x: n.x - 76, y: n.y - 28, width: 152, height: 56, rx: n.shape === 'rect' ? 0 : n.shape === 'stadium' ? 28 : 10}};
}
export function diagramEdge(a, z, direction, offset = 0) {
  const horizontal = direction === 'LR' || direction === 'RL';
  const sign = direction === 'RL' || direction === 'BT' ? -1 : 1;
  // Both endpoints are on cardinal shape boundaries (including diamond vertices).
  const x1 = a.x + (horizontal ? sign * 76 : 0), y1 = a.y + (horizontal ? 0 : sign * 28);
  const x2 = z.x - (horizontal ? sign * 76 : 0), y2 = z.y - (horizontal ? 0 : sign * 28);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return {d: horizontal ? `M${x1},${y1} C${mx},${y1+offset} ${mx},${y2+offset} ${x2},${y2}` : `M${x1},${y1} C${x1+offset},${my} ${x2+offset},${my} ${x2},${y2}`, x: mx + 6 + (horizontal ? 0 : offset * 0.75), y: my - 3 + (horizontal ? offset * 0.75 : 0)};
}
export const diagramShapeNames = {rect: '矩形', round: '圆角矩形', diamond: '菱形', stadium: '体育场形'};
export const diagramStyleNames = {solid: '实线', dashed: '虚线', thick: '粗线'};
export const diagramDirectionNames = {TD: '从上到下', TB: '从上到下', BT: '从下到上', LR: '从左到右', RL: '从右到左'};
