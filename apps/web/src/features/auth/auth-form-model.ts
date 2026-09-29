export type LoginInput = { email: string; password: string };
export type RegisterInput = LoginInput & {
  displayName: string;
  confirmPassword: string;
};

export type FormErrors = Partial<Record<keyof RegisterInput, string>>;

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validateLoginInput(input: LoginInput): FormErrors {
  const errors: FormErrors = {};
  if (!isEmail(input.email.trim())) errors.email = "请输入有效的邮箱地址";
  if (!input.password) errors.password = "请输入密码";
  return errors;
}

export function validateRegisterInput(input: RegisterInput): FormErrors {
  const errors = validateLoginInput(input);
  if (!input.displayName.trim()) errors.displayName = "请输入显示名称";
  if (input.password.length < 8) errors.password = "密码至少需要 8 个字符";
  if (input.confirmPassword !== input.password) {
    errors.confirmPassword = "两次输入的密码不一致";
  }
  return errors;
}
/** Accept only local return destinations, including their query and fragment. */
export function safeAuthReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.includes("\\") || [...decoded].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
    const url = new URL(value, "https://aistudy.invalid");
    if (url.origin !== "https://aistudy.invalid" || url.pathname.startsWith("//") || /^\/(login|register)\/?$/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function loginHrefForReturn(value: string): string {
  const destination = safeAuthReturnPath(value);
  return destination ? `/login?returnTo=${encodeURIComponent(destination)}` : "/login";
}
