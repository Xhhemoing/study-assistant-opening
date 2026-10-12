"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  /** Readable prose shown when the renderer throws; comes from the capability's toText. */
  fallbackText: string;
  /** Changing it (e.g. a new revision) retries the renderer. */
  resetKey: string | number;
  onError?: (error: unknown, info: ErrorInfo) => void;
  children: ReactNode;
};

type State = { failed: boolean; resetKey: string | number };

export const RENDER_FAILED_NOTE = "交互版暂不可用，以下为同一内容的文字版本。";

export function RenderFallback({ text }: { text: string }) {
  return (
    <div className="space-y-1.5" role="status" data-jingwei-fallback="render_error">
      <p className="text-[11px] text-zinc-500">{RENDER_FAILED_NOTE}</p>
      <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{text}</p>
    </div>
  );
}

/** A crashing renderer degrades to its text form; the rest of the page keeps working. */
export class RenderBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  render() {
    return this.state.failed ? <RenderFallback text={this.props.fallbackText} /> : this.props.children;
  }
}
