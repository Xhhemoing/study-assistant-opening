import Link from "next/link";
import { AuthForm } from "../../features/auth/auth-form";

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="login-title">
        <a className="auth-brand" href="/">AIstudy</a>
        <div className="auth-panel__header">
          <h1 id="login-title">欢迎回来</h1>
          <p>继续你的学习、探索和长期知识积累。</p>
        </div>
        <AuthForm mode="login" />
        <p className="auth-switch">还没有账户？ <Link href="/register">创建账户</Link></p>
      </section>
    </main>
  );
}