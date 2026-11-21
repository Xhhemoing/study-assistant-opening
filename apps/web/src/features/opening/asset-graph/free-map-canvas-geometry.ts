export type MapPoint = { x: number; y: number };
export type MapCamera = MapPoint & { k: number };
export const MAP_NODE_WIDTH = 216;
export const MAP_NODE_HEIGHT = 88;
export const DEFAULT_MIN_ZOOM = 0.2;

export const clampMapZoom = (k: number, minimum = DEFAULT_MIN_ZOOM) =>
  Math.min(3, Math.max(minimum, k));

export function zoomFreeMapAt(
  camera: MapCamera,
  scale: number,
  anchor: MapPoint,
  minimum = DEFAULT_MIN_ZOOM,
): MapCamera {
  const k = clampMapZoom(scale, minimum);
  const ratio = k / camera.k;
  return {
    k,
    x: anchor.x - (anchor.x - camera.x) * ratio,
    y: anchor.y - (anchor.y - camera.y) * ratio,
  };
}

export function fitFreeMap(
  points: readonly MapPoint[],
  size: { width: number; height: number },
): MapCamera {
  if (!points.length) return { x: size.width / 2, y: size.height / 2, k: 1 };
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs) - MAP_NODE_WIDTH / 2 - 40;
  const maxX = Math.max(...xs) + MAP_NODE_WIDTH / 2 + 40;
  const minY = Math.min(...ys) - MAP_NODE_HEIGHT / 2 - 55;
  const maxY = Math.max(...ys) + MAP_NODE_HEIGHT / 2 + 55;
  // Fit may go below the interactive zoom floor so large loaded graphs remain recoverable.
  const k = Math.min(1.15, size.width / (maxX - minX), size.height / (maxY - minY));
  return {
    k,
    x: size.width / 2 - ((minX + maxX) / 2) * k,
    y: size.height / 2 - ((minY + maxY) / 2) * k,
  };
}

/** The first view keeps labels readable; fitting the entire graph remains an explicit action. */
export function initialFreeMapCamera(
  points: readonly MapPoint[],
  size: { width: number; height: number },
  focus?: MapPoint,
): MapCamera {
  const fitted = fitFreeMap(points, size);
  if (fitted.k >= 0.75 || !points.length) return fitted;
  const point = focus ?? points[0]!;
  return { k: 0.75, x: size.width / 2 - point.x * 0.75, y: size.height / 2 - point.y * 0.75 };
}

export function curveBetween(
  from: MapPoint,
  to: MapPoint,
  lane = 0,
  count = 1,
): { d: string; label: MapPoint } {
  if (from.x === to.x && from.y === to.y) {
    const rise = 105 + lane * 30;
    return {
      d: `M ${from.x - 36} ${from.y - 44} C ${from.x - 150} ${from.y - rise} ${from.x + 150} ${from.y - rise} ${from.x + 36} ${from.y - 44}`,
      label: { x: from.x, y: from.y - rise + 8 },
    };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ratio = Math.max(
    Math.abs(dx) / (MAP_NODE_WIDTH / 2 + 5),
    Math.abs(dy) / (MAP_NODE_HEIGHT / 2 + 5),
  );
  const start = { x: from.x + dx / ratio, y: from.y + dy / ratio };
  const end = { x: to.x - dx / ratio, y: to.y - dy / ratio };
  const spread = (lane - (count - 1) / 2) * 42;
  const distance = Math.hypot(dx, dy);
  const xWeight = (dx / distance) ** 2;
  const bend = {
    x: (end.x - start.x) * 0.55 * xWeight,
    y: (end.y - start.y) * 0.55 * (1 - xWeight),
  };
  const offset = { x: (-dy / distance) * spread, y: (dx / distance) * spread };
  const c1 = { x: start.x + bend.x + offset.x, y: start.y + bend.y + offset.y };
  const c2 = { x: end.x - bend.x + offset.x, y: end.y - bend.y + offset.y };
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`,
    label: {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 - 7,
    },
  };
}
