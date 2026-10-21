import { cloneElement, isValidElement, useId, type ReactNode } from "react";

export function Field({ label, htmlFor, error, description, children }: { label: string; htmlFor?: string; error?: string; description?: string; children: ReactNode }) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  // Link a direct input/select/textarea without changing composite children.
  const control = isValidElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" }>(children) && typeof children.type === "string" && ["input", "select", "textarea"].includes(children.type)
    ? cloneElement(children, {
      id: children.props.id ?? controlId,
      "aria-describedby": [children.props["aria-describedby"], description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined,
      "aria-invalid": error ? true : children.props["aria-invalid"],
    })
    : children;
  const labelTarget = isValidElement<{ id?: string }>(control) ? control.props.id ?? controlId : controlId;
  return (
    <div className="grid gap-2">
      <label className="text-xs font-medium text-text-2" htmlFor={labelTarget}>{label}</label>
      {description ? <p id={descriptionId} className="text-xs leading-5 text-text-2">{description}</p> : null}
      {control}
      {error ? <p id={errorId} className="text-xs leading-5 text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
