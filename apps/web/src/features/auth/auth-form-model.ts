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