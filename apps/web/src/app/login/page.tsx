import Link from "next/link";
import { AuthForm } from "../../features/auth/auth-form";
import { AuthFrame } from "../../features/auth/auth-frame";
import { safeAuthReturnPath } from "../../features/auth/auth-form-model";
import { isOpeningRelease } from "../../features/opening/access-policy";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const returnTo = safeAuthReturnPath((await searchParams).returnTo);
  return <AuthFrame title="欢迎回来" titleId="login-title" description="继续你的学习、探索和长期知识积累。" footer={isOpeningRelease() ? <>当前版本仅对已有账户开放。</> : <>还没有账户？ <Link className="text-emerald-800 underline underline-offset-4" href="/register">创建账户</Link></>}><AuthForm mode="login" returnTo={returnTo} /></AuthFrame>;
}
