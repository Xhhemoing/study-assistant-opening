import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the component's actual handlers without adding a DOM dependency.
const effects: Array<() => unknown> = [];
const states: unknown[] = [];
const refs: Array<{ current: unknown }> = [];
let stateIndex = 0;
let refIndex = 0;
let cleanups: Array<() => void> = [];

vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { effects.push(effect); },
  useRef: (initial: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
  useState: (initial: unknown) => {
    const index = stateIndex++;
    if (states[index] === undefined) states[index] = initial;
    return [states[index], (value: unknown) => {
      states[index] = typeof value === "function" ? value(states[index]) : value;
    }];
  },
}));

import { FocusTimer } from "./focus-timer";

type ControlProps = {
  children?: ReactNode;
  "aria-expanded"?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
};

function controls(node: ReactNode, type: string): Array<ReactElement<ControlProps>> {
  if (Array.isArray(node)) return node.flatMap(child => controls(child, type));
  if (!isValidElement<ControlProps>(node)) return [];
  return [...(node.type === type ? [node] : []), ...controls(node.props.children, type)];
}

class TimerNode {}
let documentTarget: EventTarget;
let inside: TimerNode;
const focusTrigger = vi.fn();
const querySelector = vi.fn();

function renderTimer() {
  cleanups.forEach(cleanup => cleanup());
  cleanups = [];
  effects.length = 0;
  stateIndex = 0;
  refIndex = 0;
  const tree = FocusTimer();
  refs[0].current = { contains: (target: unknown) => target === inside };
  refs[1].current = { focus: focusTrigger };
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
  }
  return tree;
}

function openTimer() {
  const tree = renderTimer();
  controls(tree, "button")[0].props.onClick?.();
  return renderTimer();
}

function keydown(key = "Escape") {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  documentTarget.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  states.length = 0;
  refs.length = 0;
  inside = new TimerNode();
  documentTarget = new EventTarget();
  querySelector.mockReturnValue(null);
  vi.stubGlobal("document", Object.assign(documentTarget, { querySelector }));
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("Node", TimerNode);
});

afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  cleanups = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("focus timer panel dismissal", () => {
  it("closes on Escape, restores trigger focus, and consumes the shortcut", () => {
    openTimer();
    const event = keydown();
    expect(controls(renderTimer(), "button")[0].props["aria-expanded"]).toBe(false);
    expect(focusTrigger).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps the panel open for internal pointer events and closes for an outside pointer", () => {
    openTimer();
    const pointer = new Event("pointerdown");
    Object.defineProperty(pointer, "target", { value: inside });
    documentTarget.dispatchEvent(pointer);
    expect(controls(renderTimer(), "button")[0].props["aria-expanded"]).toBe(true);
    const outsidePointer = new Event("pointerdown");
    Object.defineProperty(outsidePointer, "target", { value: new TimerNode() });
    documentTarget.dispatchEvent(outsidePointer);
    expect(controls(renderTimer(), "button")[0].props["aria-expanded"]).toBe(false);
    expect(focusTrigger).not.toHaveBeenCalled();
  });

  it("leaves Escape to an open native dialog or a handler that already consumed it", () => {
    openTimer();
    querySelector.mockReturnValue({ open: true });
    expect(keydown().defaultPrevented).toBe(false);
    expect(controls(renderTimer(), "button")[0].props["aria-expanded"]).toBe(true);
    querySelector.mockReturnValue(null);
    const handled = new Event("keydown", { cancelable: true });
    Object.defineProperty(handled, "key", { value: "Escape" });
    handled.preventDefault();
    documentTarget.dispatchEvent(handled);
    expect(controls(renderTimer(), "button")[0].props["aria-expanded"]).toBe(true);
    expect(focusTrigger).not.toHaveBeenCalled();
  });

  it("preserves the running timer on dismissal and keeps pause, duration, and reset working", () => {
    let tree = openTimer();
    controls(tree, "select")[0].props.onChange?.({ target: { value: "15" } });
    tree = renderTimer();
    controls(tree, "button")[1].props.onClick?.();
    renderTimer();
    vi.advanceTimersByTime(10_000);
    keydown();
    expect(states[1]).toBe(890);
    expect(states[2]).not.toBeNull();
    tree = openTimer();
    expect(controls(tree, "select")[0].props.disabled).toBe(true);
    controls(tree, "button")[1].props.onClick?.();
    tree = renderTimer();
    expect(controls(tree, "select")[0].props.disabled).toBe(false);
    expect(states[1]).toBe(890);
    controls(tree, "button")[2].props.onClick?.();
    renderTimer();
    expect(states[1]).toBe(900);
    expect(states[2]).toBeNull();
  });
});
