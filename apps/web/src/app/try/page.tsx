import Link from "next/link";
import { notFound } from "next/navigation";
import { allowsPublicTryChallenge, publicTryEntry } from "../../features/opening/access-policy";
import { ChallengeSheet } from "../../features/opening/public-try/challenge-sheet";
import { challenges } from "../../features/opening/public-try/challenges";
import { parseTryContinuation, type TrySearchParams } from "../../features/opening/public-try/continuation";

export const dynamic = "force-dynamic";
export const metadata = { title: "找出推导中的错步 · AIstudy" };

export default async function PublicTryPage({ searchParams }: { searchParams: Promise<TrySearchParams> }) {
  if (!allowsPublicTryChallenge()) notFound();
  const params = await searchParams;
  const context = parseTryContinuation(params);
  if (context && (params.continued === "login" || params.continued === "register")) {
    const question = challenges.find(item => item.id === context.challenge)!;
    const registered = params.continued === "register";
    return (
      <main className="mx-auto max-w-2xl px-5 py-12 text-ink">
        <h1 className="font-serif text-3xl font-semibold">接着刚才的挑战</h1>
        <h2 className="mt-6 text-xl font-semibold">{question.question}</h2>
        <p className="mt-4 text-read">你选择了第 {context.step + 1} 步：{question.steps[context.step]}</p>
        <p className="mt-3 rounded-md bg-surface-2 p-4 text-read">错在第 {question.brokenStep + 1} 步。{question.diagnosis}</p>
        <Link className="mt-6 inline-block rounded-ctl bg-ink px-4 py-3 text-on-ink focus-visible:outline-focus-ring" href={registered ? "/onboarding" : "/"}>
          {registered ? "继续设置账户" : "进入学习空间"}
        </Link>
      </main>
    );
  }
  return <ChallengeSheet entry={publicTryEntry()} />;
}
