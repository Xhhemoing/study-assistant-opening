"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  type FormErrors,
  validateLoginInput,
  validateRegisterInput,
} from "./auth-form-model";

type AuthMode = "login" | "register";

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      displayName: String(data.get("displayName") ?? ""),
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      confirmPassword: String(data.get("confirmPassword") ?? ""),
    };
    const nextErrors = mode === "register"
      ? validateRegisterInput(input)
      : validateLoginInput(input);

    setErrors(nextErrors);
    setServerError("");
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "register"
            ? { email: input.email, password: input.password, displayName: input.displayName }
            : { email: input.email, password: input.password },
        ),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "暂时无法完成请求，请稍后重试");
      }
      router.replace(mode === "register" ? "/onboarding" : "/");
      router.refresh();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : "暂时无法完成请求，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      {mode === "register" ? (
        <Field label="显示名称" name="displayName" error={errors.displayName} autoComplete="name" />
      ) : null}
      <Field label="邮箱" name="email" type="email" error={errors.email} autoComplete="email" />
      <Field
        label="密码"
        name="password"
        type="password"
        error={errors.password}
        autoComplete={mode === "register" ? "new-password" : "current-password"}
      />
      {mode === "register" ? (
        <Field
          label="确认密码"
          name="confirmPassword"
          type="password"
          error={errors.confirmPassword}
          autoComplete="new-password"
        />
      ) : null}
      {serverError ? <p className="form-error form-error--server" role="alert">{serverError}</p> : null}
      <button className="button auth-form__submit" type="submit" disabled={submitting}>
        {submitting ? <LoaderCircle className="spinner" aria-hidden="true" size={18} /> : null}
        {mode === "register" ? "创建账户" : "登录"}
        {!submitting ? <ArrowRight aria-hidden="true" size={18} /> : null}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  error,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  autoComplete: string;
}) {
  const errorId = `${name}-error`;
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      />
      {error ? <small id={errorId} className="form-error">{error}</small> : null}
    </label>
  );
}