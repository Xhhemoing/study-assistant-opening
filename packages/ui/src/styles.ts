/** Shared utility classes keep the opening compatibility API and primitives aligned. */
export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const motion = "transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-expo active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100";
const control = "inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-md px-3 text-sm font-medium disabled:pointer-events-none disabled:opacity-50";
export const fieldClass = `min-h-11 min-w-0 w-full rounded-md border border-text-3 bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 disabled:opacity-50 ${focusRing}`;
export const ui = {
  primary: `${control} bg-ink text-on-ink hover:bg-ink/90 ${motion} ${focusRing}`,
  secondary: `${control} border border-text-3 bg-surface text-text hover:bg-surface-2 ${motion} ${focusRing}`,
  quiet: `${control} text-text-2 hover:bg-surface-2 hover:text-text ${motion} ${focusRing}`,
  danger: `${control} border border-danger bg-surface text-danger hover:bg-danger/10 ${motion} ${focusRing}`,
  icon: `inline-flex size-11 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-surface-2 aria-pressed:text-text ${motion} ${focusRing}`,
  input: fieldClass,
  panel: "rounded-card border border-line bg-surface text-text shadow-card",
  label: "text-xs font-medium text-text-2",
  badge: "inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-pill px-2 text-xs font-medium leading-4",
  segment: "flex gap-1 rounded-md bg-surface-2 p-1",
  segmentItem: `min-h-11 flex-1 rounded-sm px-3 text-sm text-text-2 transition-colors duration-200 hover:text-text aria-pressed:bg-surface aria-pressed:font-medium aria-pressed:text-text aria-pressed:shadow-card motion-reduce:transition-none ${focusRing}`,
} as const;
export const tone = {
  neutral: "bg-surface-2 text-text-2",
  success: "bg-accent-soft text-accent",
  warning: "bg-warn-soft text-warn",
  danger: "bg-surface text-danger ring-1 ring-inset ring-danger/30",
} as const;
