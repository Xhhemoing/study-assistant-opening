"use client";

import type { LearningPreferences } from "@aistudy/contracts";
import { LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DingTalkConnectionsPanel } from "./dingtalk-connections-panel";
import { SemesterSettingsForm } from "../opening/timetable/semester-settings-form";
import { TimetableImport } from "../opening/timetable/timetable-import";
import {
  disabledLearningPreferences,
  fetchWorkspacePreferences,
  learningSwitches,
  putWorkspacePreferences,
} from "./settings-shared";

const navLinkClass = "text-sm text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 rounded-sm";

export function SettingsView() {
  const [learningPreferences, setLearningPreferences] = useState<LearningPreferences>(disabledLearningPreferences);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const body = await fetchWorkspacePreferences();
      setLearningPreferences(body.learningPreferences ?? disabledLearningPreferences);
    } catch {
      setError("设置暂时无法读取，请重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveLearningPreferences() {
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = await putWorkspacePreferences({ learningPreferences });
      setLearningPreferences(body.learningPreferences ?? learningPreferences);
      setNotice("学习偏好已保存。");
    } catch {
      setError("学习偏好保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 bg-white">
      <PageHeading
        title="设置"
        description="管理数据连接、开学排程与学习偏好。AI 模型、默认入口、诊断等见高级设置。"
      />
      <div className="mx-auto max-w-4xl space-y-6 px-5 py-5">
        <nav aria-label="设置分区" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
          <a className={navLinkClass} href="#connections">连接</a>
          <span aria-hidden="true">·</span>
          <a className={navLinkClass} href="#planning">排程</a>
          <span aria-hidden="true">·</span>
          <a className={navLinkClass} href="#preferences">学习偏好</a>
          <span aria-hidden="true">·</span>
          <Link className={navLinkClass} href="/settings/advanced">高级</Link>
          <span aria-hidden="true">·</span>
          <Link className={navLinkClass} href="/settings/advanced#daily-budget">开启 AI 每日额度</Link>
        </nav>

        <section id="connections" className="scroll-mt-6 space-y-6 border-b border-zinc-200 pb-6" aria-labelledby="opening-connections-heading">
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div>
              <h2 className="text-sm font-medium text-zinc-900" id="opening-connections-heading">数据连接</h2>
              <p className="mt-1 text-xs leading-6 text-zinc-500">邮箱与钉钉授权、暂停、撤销与手工导入。</p>
            </div>
            <div>
              <Link className={ui.secondary} href="/opening/settings/connections">打开连接设置</Link>
            </div>
          </div>
          <DingTalkConnectionsPanel />
        </section>

        <section id="planning" className="scroll-mt-6 grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="opening-planning-heading">
          <div>
            <h2 className="text-sm font-medium text-zinc-900" id="opening-planning-heading">开学排程</h2>
            <p className="mt-1 text-xs leading-6 text-zinc-500">导入课表并确认学期设置后，今天页可用「按建议安排」一键生成草案。</p>
          </div>
          <div className="space-y-8">
            <SemesterSettingsForm />
            <TimetableImport />
          </div>
        </section>

        <section id="preferences" className="scroll-mt-6 grid gap-4 border-b border-zinc-200 pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="learning-preferences-heading">
          <div>
            <h2 className="text-sm font-medium text-zinc-900" id="learning-preferences-heading">学习偏好</h2>
            <p className="mt-1 text-xs leading-6 text-zinc-500">评价、补测与提醒，直接影响学习闭环。</p>
          </div>
          <div className="space-y-3">
            {loading ? <LoadingRows label="正在读取设置" /> : null}
            {error ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3" role="alert">
                <p className="text-sm text-red-700">{error}</p>
                <button className={ui.secondary} onClick={() => void loadSettings()} type="button">
                  <RefreshCw aria-hidden="true" size={14} />重新读取
                </button>
              </div>
            ) : null}
            {!loading ? (
              <>
                <div className="divide-y divide-zinc-100">
                  {learningSwitches.map(({ key, label }) => (
                    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-zinc-700 focus-within:ring-2 focus-within:ring-emerald-700" key={key}>
                      <span>{label}</span>
                      <input
                        checked={learningPreferences[key]}
                        className="size-4 accent-emerald-700"
                        disabled={key !== "assessmentEnabled" && !learningPreferences.assessmentEnabled}
                        onChange={(event) => setLearningPreferences((current) =>
                          key === "assessmentEnabled" && !event.target.checked
                            ? disabledLearningPreferences
                            : { ...current, [key]: event.target.checked },
                        )}
                        type="checkbox"
                      />
                    </label>
                  ))}
                </div>
                <button className={ui.primary} disabled={saving} onClick={() => void saveLearningPreferences()} type="button">
                  {saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}
                  保存学习偏好
                </button>
              </>
            ) : null}
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs leading-6 text-zinc-500">AI 模型与每日额度、默认入口、指导模式、计划自主权、导出与诊断等在高级设置。</p>
          <div className="flex flex-wrap gap-2">
            <Link className={ui.secondary} href="/settings/advanced#daily-budget">AI 模型与每日额度</Link>
            <Link className={ui.secondary} href="/settings/advanced">打开高级设置</Link>
          </div>
        </div>

        {notice ? <p className="text-sm text-emerald-700" role="status">{notice}</p> : null}
      </div>
    </main>
  );
}
