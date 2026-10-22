import { fieldClass } from "./controls";
import { useReplay } from "../motion/feedback";
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/** 表单字段：标签在上、说明与错误在下，错误用 aria-describedby 关联。 */
/** shakeKey：每次提交校验失败时 +1，字段抖动一次（error state shake），不重挂载输入框。 */
export function Field({ label, hint, error, shakeKey = 0, children }: { label: string; hint?: string; error?: string; shakeKey?: number; children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode }) {
  const id = useId();
  const shaking = useReplay(error ? shakeKey : 0);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`space-y-1.5 ${shaking ? "motion-safe:animate-shake" : ""}`}>
      <label htmlFor={id} className="block text-meta font-medium text-text-2">{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? <p id={`${id}-error`} role="alert" className="text-meta text-danger motion-safe:animate-text-in">{error}</p>
        : hint ? <p id={`${id}-hint`} className="text-meta text-text-2">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={`${fieldClass} text-ui aria-invalid:border-danger`} {...props} />;
}

export function TextArea({ invalid, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea aria-invalid={invalid || undefined} className={`${fieldClass} min-h-24 resize-y text-ui aria-invalid:border-danger`} {...props} />;
}
