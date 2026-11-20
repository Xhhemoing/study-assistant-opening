import type { AssetGraphEdge, AssetGraphNode } from "@aistudy/contracts";
import type { MapPoint } from "./free-map-canvas-geometry";

export type FreeMapLayout = {
  positions: Record<string, MapPoint>;
  /** A display forest for moving branches; never a source of semantic edges. */
  parents: Record<string, string | null>;
  branches: Record<string, number>;
  depths: Record<string, number>;
};

export function emptyFreeMapLayout(): FreeMapLayout {
  return { positions: {}, parents: {}, branches: {}, depths: {} };
}

const kindOrder: Record<AssetGraphNode["kind"], number> = {
  course: 0,
  goal: 1,
  exploration: 2,
  requirement: 3,
  knowledge: 4,
  document: 5,
  source: 6,
  observation: 7,
};

/** Append geometry only. Already seen nodes (including temporarily absent ones) stay put. */
export function extendFreeMapLayout(
  previous: FreeMapLayout,
  nodes: readonly AssetGraphNode[],
  edges: readonly AssetGraphEdge[],
  restored: Readonly<Record<string, MapPoint>> = {},
): FreeMapLayout {
  const layout: FreeMapLayout = {
    positions: { ...previous.positions },
    parents: { ...previous.parents },
    branches: { ...previous.branches },
    depths: { ...previous.depths },
  };
  const ordered = [...nodes].sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.id.localeCompare(b.id),
  );
  const ids = new Set(nodes.map(node => node.id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.add(edge.to);
  }
  const occupied = Object.values(layout.positions);
  function place(id: string, parent: string | null) {
    const siblings = Object.keys(layout.parents).filter(key => layout.parents[key] === parent);
    const branch =
      parent === null
        ? siblings.length % 3
        : layout.parents[parent] === null
          ? siblings.length % 3
          : (layout.branches[parent] ?? 0);
    const depth = parent === null ? 0 : (layout.depths[parent] ?? 0) + 1;
    // Fixed slots stay compact without repositioning roots when another page arrives.
    const origin = parent
      ? layout.positions[parent]!
      : { x: (siblings.length % 4) * 280, y: Math.floor(siblings.length / 4) * 130 };
    const side =
      parent && layout.parents[parent] !== null
        ? Math.sign(origin.x - (layout.positions[layout.parents[parent] ?? ""]?.x ?? origin.x - 1)) ||
          1
        : siblings.length % 3 === 0
          ? -1
          : 1;
    const preferred =
      parent === null
        ? origin
        : {
            x: origin.x + side * 320,
            y:
              origin.y +
              (siblings.length === 0 ? -100 : siblings.length === 1 ? -130 : 150) +
              Math.floor(siblings.length / 3) * 140,
          };
    let point = restored[id];
    if (!point) {
      point = preferred;
      let attempt = 0;
      while (
        occupied.some(
          other => Math.abs(other.x - point!.x) < 260 && Math.abs(other.y - point!.y) < 118,
        )
      ) {
        attempt += 1;
        point = {
          x: preferred.x,
          y: preferred.y + (attempt % 2 ? 1 : -1) * Math.ceil(attempt / 2) * 130,
        };
      }
    }
    layout.parents[id] = parent;
    layout.positions[id] = point;
    layout.branches[id] = branch;
    layout.depths[id] = depth;
    occupied.push(point);
  }
  const visited = new Set<string>();
  function visit(start: string) {
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const child of outgoing.get(id) ?? []) {
        if (!Object.hasOwn(layout.parents, child)) place(child, id);
        // Pre-existing parents remain authoritative, including on later pages.
        if (layout.parents[child] === id) queue.push(child);
      }
    }
  }
  for (const node of ordered) if (Object.hasOwn(layout.parents, node.id)) visit(node.id);
  for (const node of [...ordered.filter(node => !incoming.has(node.id)), ...ordered]) {
    if (!Object.hasOwn(layout.parents, node.id)) {
      place(node.id, null);
      visit(node.id);
    }
  }
  return layout;
}

export function freeMapDescendants(layout: FreeMapLayout, id: string): string[] {
  const children = new Map<string, string[]>();
  for (const [child, parent] of Object.entries(layout.parents)) {
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const result = [id];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index += 1) {
    for (const child of children.get(result[index]!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        result.push(child);
      }
    }
  }
  return result;
}

export function freeMapVisibleIds(
  layout: FreeMapLayout,
  nodes: readonly AssetGraphNode[],
  folded: ReadonlySet<string>,
): Set<string> {
  const active = new Set(nodes.map(node => node.id));
  return new Set(
    nodes
      .filter(node => {
        let parent = layout.parents[node.id];
        while (parent != null) {
          // Filtering a parent must not make a loaded child disappear.
          if (active.has(parent) && folded.has(parent)) return false;
          parent = layout.parents[parent];
        }
        return true;
      })
      .map(node => node.id),
  );
}

export function moveFreeMapNodes(
  layout: FreeMapLayout,
  ids: readonly string[],
  delta: MapPoint,
): FreeMapLayout {
  const positions = { ...layout.positions };
  for (const id of ids) {
    const point = positions[id];
    if (point) positions[id] = { x: point.x + delta.x, y: point.y + delta.y };
  }
  return { ...layout, positions };
}

/** A page can arrive while a pointer is held. Merge the drag into the latest graph. */
export function moveFreeMapFromOrigin(
  current: FreeMapLayout,
  origin: FreeMapLayout,
  ids: readonly string[],
  delta: MapPoint,
): FreeMapLayout {
  const moved = moveFreeMapNodes(origin, ids, delta);
  const positions = { ...current.positions };
  for (const id of ids) if (moved.positions[id]) positions[id] = moved.positions[id]!;
  return { ...current, positions };
}
