"use client";
import { useState } from "react";
import { z } from "zod";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
import { ui } from "../../design/ui";
import { studentCopy } from "../student-copy";
import { userFacingMessage } from "../../../../lib/user-facing-error";
const pair = z.tuple([z.string(), z.string()]);
const solutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unique"), coefficients: pair }),
  z.object({ kind: z.literal("infinite"), particular: pair, directions: z.array(pair) }),
  z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("unknown"), reason: z.string() }),
]);
const feedbackSchema = z.object({ attemptId: z.string().uuid(), exposureReceipt: z.object({ id: z.string().uuid() }),
  result: z.object({ solution: solutionSchema, failedCoordinates: z.array(z.number().int().nonnegative()) }) });
export function SpanFeedback({ attemptId }: { attemptId: string }) {
  const [feedback, setFeedback] = useState<z.infer<typeof feedbackSchema> | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  async function reveal() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/opening/teaching/span/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId }) });
      if (!response.ok) throw new Error("本题解法暂不可读取；原答案与评价保留。");
      const result = feedbackSchema.parse(await response.json());
      if (result.attemptId !== attemptId) throw new Error("反馈与原题不一致，已停止显示。");
      setFeedback(result); void acknowledgeStudyExposure(result.exposureReceipt).catch(() => undefined);
    } catch (reason) { setError(userFacingMessage(reason, "反馈暂不可读取")); }
    finally { setPending(false); }
  }
  const solution = feedback?.result.solution;
  return <div className="space-y-2">
    {!feedback ? <button type="button" className={ui.secondary} disabled={pending} onClick={() => void reveal()}>{pending ? "正在读取核对解法…" : studentCopy.reference}</button> : <div className="space-y-2 rounded-lg border border-line bg-accent-soft text-text p-3 text-sm leading-7">
      <p className="font-medium">本题参考核对</p>
      {solution?.kind === "unique" ? <p>方程组有唯一解：α={solution.coefficients[0]}，β={solution.coefficients[1]}。将这两个数分别乘到 v、w，逐个坐标相加应与 u 完全相同。</p> : solution?.kind === "infinite" ? <p>方程组有多组系数。一组是 α={solution.particular[0]}，β={solution.particular[1]}；通解是在这组上加上 {solution.directions.map(direction => `t·(${direction.join(", ")})`).join("、")}。不同参数也可表示同一个向量。</p> : solution?.kind === "none" ? <p>整个坐标方程组无解，所以不属于 span。检查你用于求候选系数的坐标，再代回剩下的坐标；至少一个条件无法同时满足。生成向量相关时，也可找同时垂直于 v、w 但不垂直于 u 的证书。</p> : <p>这道题暂时无法自动给出参考解法，可以先自己对照检查。</p>}
      {feedback?.result.failedCoordinates.length ? <p>你的候选系数未满足第 {feedback.result.failedCoordinates.map(index => index + 1).join("、")} 个坐标。先回到这些坐标检查乘法和加法。</p> : null}
      <p className="text-xs text-text-3">对照之后，合上解法，再试着自己完成一步。</p>
    </div>}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
  </div>;
}
