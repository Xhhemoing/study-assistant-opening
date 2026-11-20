import Link from "next/link";
import { AuthForm } from "../../features/auth/auth-form";
import { AuthFrame } from "../../features/auth/auth-frame";
import { allowsPublicTryChallenge, isOpeningRelease } from "../../features/opening/access-policy";
import { parseTryContinuation, tryAuthHref, type TrySearchParams } from "../../features/opening/public-try/continuation";

export default async function LoginPage({ searchParams }: { searchParams: Promise<TrySearchParams> }) {
  const params = await searchParams;
  const tryContext = allowsPublicTryChallenge() ? parseTryContinuation(params) : null;
  const fromTry = [params.from].flat().includes("try");
  const footer = isOpeningRelease() ? <>当前版本仅对已有账户开放。</> : <>还没有账户？ <Link className="text-accent underline underline-offset-4" href={tryAuthHref("/register", tryContext)}>创建账户</Link></>;
  return (
    <AuthFrame title="欢迎回来" titleId="login-title" description={tryContext ? "登录后可接着查看刚才的错步诊断。" : "继续你的学习、探索和长期知识积累。"} footer={footer}>
      <AuthForm mode="login" returnTo={fromTry ? undefined : params.returnTo} tryContext={tryContext} />
    </AuthFrame>
  );
}
