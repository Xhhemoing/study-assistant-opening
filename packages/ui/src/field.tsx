import type { ReactNode } from "react";

export function Field({ label, htmlFor, error, description, children }: { label: string; htmlFor?: string; error?: string; description?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <label className="text-sm font-semibold text-text" htmlFor={htmlFor}>{label}</label>
      {description ? <p className="text-xs text-text-dim">{description}</p> : null}
      {children}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
