"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_MIN_ZOOM,
  clampMapZoom,
  fitFreeMap,
  initialFreeMapCamera,
  zoomFreeMapAt,
  type MapCamera,
  type MapPoint,
} from "./free-map-canvas-geometry";
import { moveFreeMapFromOrigin, type FreeMapLayout } from "./free-map-canvas-layout";

type Gesture = {
  origin: MapPoint;
  camera: MapCamera;
  layout: FreeMapLayout;
  ids: string[] | null;
  selectedId: string | null;
  moved: boolean;
};
type Pinch = { center: MapPoint; distance: number; camera: MapCamera };

export function useFreeMapGestures({
  layout,
  points,
  initialFocus,
  moveIds,
  onLayout,
  onSave,
  onSelect,
}: {
  layout: FreeMapLayout;
  points: readonly MapPoint[];
  initialFocus?: MapPoint;
  moveIds: (id: string, alt: boolean) => string[];
  onLayout: (layout: FreeMapLayout) => void;
  onSave: (layout: FreeMapLayout) => void;
  onSelect: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [camera, setCameraState] = useState<MapCamera>({ x: 450, y: 280, k: 1 });
  const [dragging, setDragging] = useState(false);
  const liveCamera = useRef(camera);
  const minimumZoom = useRef(DEFAULT_MIN_ZOOM);
  const latest = useRef({ layout, points, initialFocus, moveIds, onLayout, onSave, onSelect });
  latest.current = { layout, points, initialFocus, moveIds, onLayout, onSave, onSelect };
  const pointers = useRef(new Map<number, MapPoint>());
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const initialFit = useRef(false);
  const previousCamera = useRef<MapCamera | null>(null);
  const [canReturn, setCanReturn] = useState(false);

  function setCamera(next: MapCamera) {
    minimumZoom.current = Math.min(minimumZoom.current, next.k);
    liveCamera.current = next;
    setCameraState(next);
  }
  function rememberView() {
    previousCamera.current = liveCamera.current;
    setCanReturn(true);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let previousSize = { width: 900, height: 560 };
    function resize() {
      const rect = svg!.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const next = { width: rect.width, height: rect.height };
      setSize(next);
      if (!initialFit.current && latest.current.points.length) {
        setCamera(
          initialFreeMapCamera(latest.current.points, next, latest.current.initialFocus),
        );
        initialFit.current = true;
      } else {
        setCamera({
          ...liveCamera.current,
          x: liveCamera.current.x + (next.width - previousSize.width) / 2,
          y: liveCamera.current.y + (next.height - previousSize.height) / 2,
        });
      }
      previousSize = next;
    }
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!initialFit.current && points.length) {
      setCamera(initialFreeMapCamera(points, size, initialFocus));
      initialFit.current = true;
    }
  }, [points, size, initialFocus]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const rect = svg!.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const bounded = Math.max(-120, Math.min(120, delta));
      setCamera(
        zoomFreeMapAt(
          liveCamera.current,
          liveCamera.current.k * Math.exp(-bounded * 0.002),
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          minimumZoom.current,
        ),
      );
    }
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, []);

  function localPoint(event: ReactPointerEvent<SVGSVGElement>): MapPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function pinchStats() {
    const [a, b] = [...pointers.current.values()] as [MapPoint, MapPoint];
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }
  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.pointerType !== "touch") return;
    const target = event.target as Element;
    if (target.closest("[data-map-control]")) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (pointers.current.size >= 2) {
      const current = gesture.current;
      if (current?.moved && current.ids) latest.current.onSave(latest.current.layout);
      pinch.current = { ...pinchStats(), camera: liveCamera.current };
      gesture.current = null;
      setDragging(true);
      return;
    }
    const element = target.closest<SVGGElement>("[data-free-map-node]");
    const id = element?.getAttribute("data-free-map-node") ?? null;
    element?.focus({ preventScroll: true });
    gesture.current = {
      origin: point,
      camera: liveCamera.current,
      layout: latest.current.layout,
      ids: id ? latest.current.moveIds(id, event.altKey) : null,
      selectedId: id,
      moved: false,
    };
  }
  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pinch.current && pointers.current.size >= 2) {
      const next = pinchStats();
      const original = pinch.current;
      const k = clampMapZoom(
        (original.camera.k * next.distance) / original.distance,
        minimumZoom.current,
      );
      const ratio = k / original.camera.k;
      setCamera({
        k,
        x: next.center.x - (original.center.x - original.camera.x) * ratio,
        y: next.center.y - (original.center.y - original.camera.y) * ratio,
      });
      return;
    }
    const current = gesture.current;
    if (!current) return;
    const dx = point.x - current.origin.x;
    const dy = point.y - current.origin.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    setDragging(true);
    if (current.ids) {
      latest.current.onLayout(
        moveFreeMapFromOrigin(latest.current.layout, current.layout, current.ids, {
          x: dx / current.camera.k,
          y: dy / current.camera.k,
        }),
      );
    } else {
      setCamera({ ...current.camera, x: current.camera.x + dx, y: current.camera.y + dy });
    }
  }
  function release(event: ReactPointerEvent<SVGSVGElement>, cancelled = false) {
    if (!pointers.current.has(event.pointerId)) return;
    if (!cancelled) onPointerMove(event);
    const current = gesture.current;
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    pinch.current = null;
    if (current?.ids && current.moved) {
      const point = localPoint(event);
      const final = moveFreeMapFromOrigin(latest.current.layout, current.layout, current.ids, {
        x: (point.x - current.origin.x) / current.camera.k,
        y: (point.y - current.origin.y) / current.camera.k,
      });
      if (!cancelled) {
        latest.current.onLayout(final);
        latest.current.onSave(final);
      } else {
        latest.current.onSave(latest.current.layout);
      }
    } else if (!cancelled && current?.selectedId && !current.moved) {
      latest.current.onSelect(current.selectedId);
    }
    if (pointers.current.size >= 2) {
      pinch.current = { ...pinchStats(), camera: liveCamera.current };
    } else if (pointers.current.size === 1) {
      const origin = [...pointers.current.values()][0]!;
      gesture.current = {
        origin,
        camera: liveCamera.current,
        layout: latest.current.layout,
        ids: null,
        selectedId: null,
        moved: true,
      };
    }
    setDragging(pointers.current.size > 0);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
  return {
    svgRef,
    size,
    camera,
    dragging,
    canReturn,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => release(event),
      onPointerCancel: (event: ReactPointerEvent<SVGSVGElement>) => release(event, true),
      onLostPointerCapture: (event: ReactPointerEvent<SVGSVGElement>) => release(event, true),
    },
    zoom: (factor: number) =>
      setCamera(
        zoomFreeMapAt(
          liveCamera.current,
          liveCamera.current.k * factor,
          { x: size.width / 2, y: size.height / 2 },
          minimumZoom.current,
        ),
      ),
    fit: (targetPoints: readonly MapPoint[] = latest.current.points) => {
      rememberView();
      setCamera(fitFreeMap(targetPoints, size));
    },
    focus: (point: MapPoint) => {
      rememberView();
      const k = Math.max(0.9, liveCamera.current.k);
      setCamera({ k, x: size.width / 2 - point.x * k, y: size.height / 2 - point.y * k });
    },
    pan: (delta: MapPoint) =>
      setCamera({
        ...liveCamera.current,
        x: liveCamera.current.x + delta.x,
        y: liveCamera.current.y + delta.y,
      }),
    back: () => {
      if (previousCamera.current) {
        setCamera(previousCamera.current);
        previousCamera.current = null;
        setCanReturn(false);
      }
    },
  };
}
