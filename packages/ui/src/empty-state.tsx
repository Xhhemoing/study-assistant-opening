import { BookOpen, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
};

export function EmptyState({ title, description, action, icon: Icon = BookOpen, className = "" }: EmptyStateProps) {
  return (
    <section className={`mx-auto flex max-w-md flex-col items-center gap-2 px-5 py-10 text-center ${className}`} aria-label={title}>
      <span className="well-recessed mb-2 inline-flex size-11 items-center justify-center rounded-xl text-text-2" aria-hidden="true">
        <Icon size={21} strokeWidth={1.75} />
      </span>
      <h2 className="font-serif text-xl font-medium leading-7 text-text">{title}</h2>
      {description ? <p className="max-w-prose text-sm leading-6 text-text-2">{description}</p> : null}
      {action ? <div className="pt-3">{action}</div> : null}
    </section>
  );
}
