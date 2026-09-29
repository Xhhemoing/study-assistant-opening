"use client";

import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  type FormErrors,
  validateLoginInput,
  validateRegisterInput,
} from "./auth-form-model";

type AuthMode = "login" | "register";

export function AuthForm({ mode, returnTo, registrationClosed = false }: {
  mode: AuthMode;
  returnTo?: string | null;
  registrationClosed?: boolean;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestPending = useRef(false);
  const closed = mode === "register" && registrationClosed;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (closed || requestPending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
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
    const firstInvalid = (["displayName", "email", "password", "confirmPassword"] as const)
      .find(name => nextErrors[name]);
    if (firstInvalid) {
      (form.elements.namedItem(firstInvalid) as HTMLInputElement | null)?.focus();
      return;
    }

    requestPending.current = true;
    setSubmitting(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "register"
            ? { email: input.email, password: input.password, displayName: input.displayName }
            : { email: input.email, password: input.password },
        ),
      });
      if (!response.ok) {
        const body = await response.json().catch(error => {
          if (controller.signal.aborted) throw error;
          return null;
        }) as
          | { error?: { message?: string } }
          | null;
        setServerError(typeof body?.error?.message === "string" && body.error.message ? body.error.message : "暂时无法完成请求，请稍后重试");
        return;
      }
      router.replace(mode === "register" ? "/onboarding" : returnTo ?? "/");
      router.refresh();
    } catch {
      setServerError(controller.signal.aborted
        ? mode === "register"
          ? "请求超时，账户可能已创建，请先尝试登录"
          : "请求超时，请检查连接后重试"
        : "无法连接到服务，请检查网络后重试");
    } finally {
      clearTimeout(timeout);
      requestPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={submitting} noValidate>
      {closed ? (
        <div id="registration-status" className="mb-6 rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <p className="text-sm font-medium text-zinc-900">注册暂未开放</p>
          <p className="mt-1 text-sm leading-6 text-zinc-600">当前版本仅对已有账户开放。</p>
        </div>
      ) : null}
      <fieldset className="min-w-0 space-y-4" disabled={closed || submitting} aria-describedby={closed ? "registration-status" : undefined}>
        <legend className="sr-only">{mode === "register" ? "注册信息" : "登录信息"}</legend>
        {mode === "register" ? (
          <Field label="显示名称" name="displayName" error={errors.displayName} autoComplete="name" maxLength={120} hint="希望我们如何称呼你" />
        ) : null}
        <Field label="邮箱" name="email" type="email" error={errors.email} autoComplete="email" maxLength={320} />
        <Field
          label="密码"
          name="password"
          type="password"
          error={errors.password}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          maxLength={200}
          minLength={mode === "register" ? 8 : 1}
          hint={mode === "register" ? "使用 8–200 个字符，建议混合字母、数字和符号。" : undefined}
        />
        {mode === "register" ? (
          <Field label="确认密码" name="confirmPassword" type="password" error={errors.confirmPassword} autoComplete="new-password" maxLength={200} />
        ) : null}
        {serverError ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700" role="alert">{serverError}</p> : null}
        <button
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-600 motion-reduce:transition-none"
          type="submit"
          disabled={closed || submitting}
        >
          {submitting ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" size={18} /> : null}
          {closed ? "注册暂未开放" : submitting ? (mode === "register" ? "正在创建账户…" : "正在登录…") : (mode === "register" ? "创建账户" : "登录")}
          {!submitting && !closed ? <ArrowRight aria-hidden="true" size={18} /> : null}
        </button>
      </fieldset>
    </form>
  );
}

function Field({ label, name, type = "text", error, autoComplete, maxLength, minLength, hint }: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  autoComplete: string;
  maxLength: number;
  minLength?: number;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = `auth-${name}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const isPassword = type === "password";
  return (
    <div className="grid gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-zinc-700">{label}</label>
      <div className="relative">
        <input
          className={`min-h-11 w-full min-w-0 rounded-md border bg-white px-3 py-2.5 text-base text-zinc-900 focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 md:text-sm ${isPassword ? "pr-12" : ""} ${error ? "border-red-500" : "border-zinc-300"}`}
          id={inputId}
          name={name}
          type={isPassword && visible ? "text" : type}
          autoComplete={autoComplete}
          required
          maxLength={maxLength}
          minLength={minLength}
          aria-invalid={Boolean(error)}
          aria-describedby={[hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
        />
        {isPassword ? (
          <button
            className="absolute inset-y-0 right-0 flex min-h-11 w-11 items-center justify-center rounded-r-md text-zinc-600 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:text-zinc-400"
            type="button"
            aria-label={`${visible ? "隐藏" : "显示"}${label}`}
            aria-pressed={visible}
            aria-controls={inputId}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {hint ? <p id={hintId} className="text-xs leading-5 text-zinc-600">{hint}</p> : null}
      {error ? <p id={errorId} className="text-sm leading-5 text-red-700">{error}</p> : null}
    </div>
  );
}
