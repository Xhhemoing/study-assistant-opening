/** Shared utility classes keep the opening compatibility API and primitives aligned. */
export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const motion = "transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-strong active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0";
/** 高度读 --control-h（v3 外观层：紧凑 36px、触屏/舒适 44px），没有外观层时仍是 44px。 */
const control = "inline-flex min-h-[var(--control-h,44px)] select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-pill-ctl,var(--radius-md))] px-[var(--control-px,14px)] text-sm font-medium disabled:pointer-events-none disabled:opacity-50";
export const fieldClass = `min-h-[var(--control-h,44px)] min-w-0 w-full rounded-[var(--radius-ctl,var(--radius-md))] border border-line-strong bg-surface px-3 py-2 text-sm text-text shadow-[var(--field-shadow)] transition-[border-color,box-shadow] duration-150 hover:border-text-3/60 focus:border-accent placeholder:text-text-3 disabled:opacity-50 motion-reduce:transition-none ${focusRing}`;
export const ui = {
  primary: `${control} keycap-ink hover:bg-ink/92 ${motion} ${focusRing}`,
  secondary: `${control} keycap text-text hover:bg-surface-2/65 ${motion} ${focusRing}`,
  quiet: `${control} text-text-2 hover:bg-text/[0.055] hover:text-text ${motion} ${focusRing}`,
  danger: `${control} border border-danger/45 bg-surface text-danger shadow-[var(--key-shadow)] hover:border-danger hover:bg-danger-soft/60 ${motion} ${focusRing}`,
  icon: `inline-flex size-[var(--control-h,44px)] shrink-0 items-center justify-center rounded-[var(--radius-pill-ctl,var(--radius-md))] text-text-2 hover:bg-text/[0.055] hover:text-text disabled:pointer-events-none disabled:opacity-50 aria-pressed:keycap aria-pressed:text-text ${motion} ${focusRing}`,
  input: fieldClass,
  panel: "rounded-card border border-line bg-surface text-text shadow-card",
  label: "text-xs font-medium text-text-2",
  badge: "inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-pill px-2 text-xs font-medium leading-4 tabular-nums",
  segment: "flex gap-1 rounded-[var(--radius-pill-ctl,var(--radius-md))] well-recessed p-1",
  segmentItem: `min-h-[var(--control-h-sm,44px)] flex-1 whitespace-nowrap rounded-[var(--radius-pill-ctl,var(--radius-sm))] px-3 text-sm text-text-2 transition-[color,background-color,box-shadow] duration-150 hover:text-text aria-pressed:keycap aria-pressed:font-medium aria-pressed:text-text motion-reduce:transition-none ${focusRing}`,
} as const;
export const tone = {
  neutral: "bg-surface-2 text-text-2",
  success: "bg-accent-soft text-accent",
  warning: "bg-warn-soft text-warn",
  danger: "bg-surface text-danger ring-1 ring-inset ring-danger/30",
} as const;
