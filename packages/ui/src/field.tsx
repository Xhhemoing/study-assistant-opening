import type { ReactNode } from "react";

export function Field({ label, htmlFor, error, description, children }: { label: string; htmlFor?: string; error?: string; description?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <label className="text-xs font-medium text-zinc-600" htmlFor={htmlFor}>{label}</label>
      {description ? <p className="text-xs text-zinc-500">{description}</p> : null}
      {children}
      {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
