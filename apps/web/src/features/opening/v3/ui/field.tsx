import { fieldClass } from "@aistudy/ui";
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/** 表单字段：标签在上、说明与错误在下，错误用 aria-describedby 关联。 */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-text-2">{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? <p id={`${id}-error`} role="alert" className="text-[13px] text-danger motion-safe:animate-enter">{error}</p>
        : hint ? <p id={`${id}-hint`} className="text-[13px] text-text-2">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={`${fieldClass} text-[15px] aria-invalid:border-danger`} {...props} />;
}

export function TextArea({ invalid, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea aria-invalid={invalid || undefined} className={`${fieldClass} min-h-24 resize-y text-[15px] leading-7 aria-invalid:border-danger`} {...props} />;
}
