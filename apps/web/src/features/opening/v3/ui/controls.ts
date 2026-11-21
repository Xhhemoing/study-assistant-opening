/**
 * v3 控件样式：尺寸、圆角、字号全部来自外观层变量（--control-h、--radius-ctl、text-ui…），
 * 换皮肤 / 密度 / 圆角只改 tailwind.css 的外观层，组件不用动。与 @aistudy/ui 的 ui.* 同名同用途，旧页面不受影响。
 */
const press = "transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--duration-micro) ease-out-strong active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0";
const base = `inline-flex h-(--control-h) shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-pill px-(--control-px) text-ui font-medium disabled:pointer-events-none disabled:opacity-45 ${press}`;

export const fieldClass = "block min-h-(--control-h) w-full min-w-0 rounded-ctl border border-line-strong bg-surface px-3 py-2 text-ui text-text shadow-[var(--field-shadow)] placeholder:text-text-3 transition-[border-color,box-shadow] duration-(--duration-micro) hover:border-text-3/60 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] focus:outline-none disabled:opacity-50";

export const ui = {
  primary: `${base} keycap-ink hover:bg-ink/90`,
  secondary: `${base} keycap text-text hover:bg-surface-2/70`,
  quiet: `${base} font-normal text-text-2 hover:bg-text/[0.055] hover:text-text`,
  danger: `${base} border border-danger/45 bg-surface text-danger shadow-[var(--key-shadow)] hover:border-danger hover:bg-danger-soft`,
  icon: `inline-grid size-(--control-h) shrink-0 place-items-center rounded-pill text-text-2 hover:bg-text/6 hover:text-text aria-pressed:keycap aria-pressed:text-text disabled:pointer-events-none disabled:opacity-45 ${press}`,
  iconSm: `inline-grid size-(--control-h-sm) shrink-0 place-items-center rounded-pill text-text-2 hover:bg-text/6 hover:text-text aria-pressed:keycap aria-pressed:text-text disabled:pointer-events-none disabled:opacity-45 ${press}`,
  chip: `inline-flex h-(--control-h-sm) items-center gap-1.5 whitespace-nowrap rounded-pill keycap px-3 text-meta text-text-2 hover:text-text ${press}`,
  input: fieldClass,
  tile: "rounded-tile border border-line bg-surface shadow-card",
  panel: "rounded-panel glass",
  segment: "inline-flex items-center gap-0.5 rounded-pill well-recessed p-1",
  segmentItem: "h-(--control-h-sm) whitespace-nowrap rounded-pill px-3 text-meta text-text-2 transition-colors duration-(--duration-micro) hover:text-text",
  /** 顶栏工具组：玻璃胶囊，内放 iconSm / 小按钮 */
  toolbar: "flex items-center gap-0.5 rounded-pill glass p-0.5",
  toolbarButton: `inline-flex h-(--control-h-sm) items-center gap-1.5 whitespace-nowrap rounded-pill px-3 text-meta font-medium text-text-2 hover:bg-text/6 hover:text-text aria-pressed:keycap aria-pressed:text-text ${press}`,
} as const;
