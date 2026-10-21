const coverHues = {
  blue: "bg-obj-1/10 ring-obj-1/20",
  amber: "bg-obj-2/10 ring-obj-2/20",
  green: "bg-obj-3/10 ring-obj-3/20",
} as const;

export type CourseCoverProps = {
  initial: string;
  hue?: keyof typeof coverHues;
  className?: string;
};

/** Decorative beside a course title; the title supplies the accessible name. */
export function CourseCover({ initial, hue = "green", className = "" }: CourseCoverProps) {
  return <span aria-hidden="true" className={`inline-flex size-12 shrink-0 items-center justify-center rounded-md font-serif text-2xl font-semibold text-text ring-1 ring-inset ${coverHues[hue]} ${className}`}>{initial}</span>;
}
