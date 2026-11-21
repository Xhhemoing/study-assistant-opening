import Link from "next/link";
import { AuthForm } from "../../features/auth/auth-form";
import { AuthFrame } from "../../features/auth/auth-frame";
import { RegistrationView } from "../../features/auth/registration-view";
import { allowsPublicTryChallenge, isOpeningRelease } from "../../features/opening/access-policy";
import { parseTryContinuation, tryAuthHref, type TrySearchParams } from "../../features/opening/public-try/continuation";

// PR-H: OPENING_RELEASE is a server switch read per request; static prerender would bake
// the build machine's value into the image (same image must differ per environment).
export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<TrySearchParams> }) {
  const registrationClosed = isOpeningRelease();
  const tryContext = allowsPublicTryChallenge() ? parseTryContinuation(await searchParams) : null;
  if (!tryContext) return <RegistrationView registrationClosed={registrationClosed} />;
  return (
    <AuthFrame title="创建账户" titleId="register-title" description={registrationClosed ? "已有账户可以登录后继续。" : "注册后可接着查看刚才的错步诊断。"}
      footer={<>已有账户？ <Link href={tryAuthHref("/login", tryContext)} className="text-accent underline underline-offset-4">登录</Link></>}>
      <AuthForm mode="register" registrationClosed={registrationClosed} tryContext={tryContext} />
    </AuthFrame>
  );
}
