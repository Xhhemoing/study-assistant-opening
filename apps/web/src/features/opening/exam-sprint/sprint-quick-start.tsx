"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { ui } from "../design/ui";
import { useTransitionRouter } from "../v3/motion/view-transition";
import { sprintCourseId } from "./sprint-course-route";

const endpoint = "/api/opening/exam-sprint/quick-start";
const retryDelayMs = 3000;
const waitLimitMs = 120_000;
const uncertain = "未能确认开启结果，请重试。";
type Status = "idle" | "starting" | "preparing" | "opening" | "retry" | "continue";

export function SprintQuickStart({ courseId }: { courseId?: string }) {
  const router = useTransitionRouter();
  const objectHref = useConversationObjectHref();
  const request = useRef<AbortController | null>(null);
  const previousCourseId = useRef(courseId);
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (previousCourseId.current === courseId) return;
    previousCourseId.current = courseId;
    request.current?.abort();
    request.current = null;
    setStatus("idle");
    setError("");
  }, [courseId]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!controller.signal.aborted && body && typeof body === "object" && "available" in body && body.available === true) {
          setAvailable(true);
        }
      } catch {
        // The existing course list remains usable when the quick-start check fails.
      }
    })();
    return () => {
      controller.abort();
      request.current?.abort();
      request.current = null;
    };
  }, []);

  function start() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("starting");
    setError("");
    let preparing = false;
    let nextPoll: number | undefined;
    const deadline = window.setTimeout(() => {
      fail(preparing ? "资料还在解析，可以继续检查。" : uncertain, preparing ? "continue" : "retry");
    }, waitLimitMs);

    function fail(message: string, nextStatus: "retry" | "continue" = "retry") {
      if (request.current !== controller) return;
      controller.abort();
      request.current = null;
      setError(message);
      setStatus(nextStatus);
    }

    controller.signal.addEventListener("abort", () => {
      window.clearTimeout(deadline);
      window.clearTimeout(nextPoll);
    }, { once: true });

    async function check() {
      try {
        const response = await fetch(endpoint, {
          method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}",
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || request.current !== controller) return;
        if (!response.ok) {
          const detail = body && typeof body === "object" && "error" in body ? body.error : null;
          const message = detail && typeof detail === "object" && "message" in detail ? detail.message : null;
          fail(response.status === 401 ? "登录状态已过期，请重新登录。" :
            userFacingMessage(typeof message === "string" ? new Error(message) : null, uncertain));
          return;
        }
        if (body && typeof body === "object") {
          if ("pending" in body && body.pending === true) {
            preparing = true;
            setStatus("preparing");
            nextPoll = window.setTimeout(() => void check(), retryDelayMs);
            return;
          }
          const resolvedCourseId = "courseId" in body && typeof body.courseId === "string" ?
            sprintCourseId({ courseId: body.courseId }) : null;
          if (resolvedCourseId) {
            const href = "/opening/courses/" + resolvedCourseId + "?mode=sprint";
            if ("href" in body && body.href === href) {
              window.clearTimeout(deadline);
              window.clearTimeout(nextPoll);
              request.current = null;
              setStatus("opening");
              try {
                router.push(objectHref(href));
              } catch {
                if (!controller.signal.aborted) {
                  setError(uncertain);
                  setStatus("retry");
                }
              }
              return;
            }
          }
        }
        fail(uncertain);
      } catch {
        if (!controller.signal.aborted) fail(uncertain);
      }
    }

    void check();
  }

  if (!available) return null;
  const pending = status === "starting" || status === "preparing" || status === "opening";
  const label = {
    idle: "一键开启", starting: "正在准备…", preparing: "正在准备…", opening: "正在进入…", retry: "重试开启", continue: "继续检查",
  }[status];

  return (
    <div className={ui.panel + " space-y-3 p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">3101 考前冲刺</h2>
          <p className="mt-1 text-sm text-text-2">准备课程和原题资料，直接进入第一轮练习。</p>
        </div>
        <button type="button" className={ui.primary} disabled={pending} onClick={start}>
          {label}<ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      {status === "preparing" ? <p role="status" className="text-sm text-text-2">正在解析原题资料，准备好后会自动进入冲刺。</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
