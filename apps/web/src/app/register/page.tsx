import Link from "next/link";
import { AuthForm } from "../../features/auth/auth-form";

export default function RegisterPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="register-title">
        <a className="auth-brand" href="/">AIstudy</a>
        <div className="auth-panel__header">
          <h1 id="register-title">建立你的学习空间</h1>
          <p>先选择一个起点。课程、目标和计划都可以稍后再设。</p>
        </div>
        <AuthForm mode="register" />
        <p className="auth-switch">已有账户？ <Link href="/login">登录</Link></p>
      </section>
    </main>
  );
}