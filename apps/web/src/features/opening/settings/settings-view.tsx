"use client";

import type { LearningPreferences } from "@aistudy/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { LoadingRows, PageHeading, ui } from "../design/ui";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { SemesterSettingsForm } from "../timetable/semester-settings-form";
import { TimetableImport } from "../timetable/timetable-import";
import { PreferenceControls } from "../teaching/preference-controls";
import { AppearanceSettings, DiagnosticsSettings } from "./appearance-settings";
import { AdvancedSettingsView } from "./advanced-settings-view";
import { disabledLearningPreferences, fetchWorkspacePreferences, learningSwitches, putWorkspacePreferences } from "./settings-shared";
import { SettingsHashRedirect } from "./settings-hash-redirect";

export type SettingsSection = "appearance" | "learning" | "ai";
const sections = [{ id: "appearance", label: "外观", suffix: "" }, { id: "learning", label: "学习", suffix: "/learning" }, { id: "ai", label: "AI 与数据", suffix: "/ai" }] as const;

export function SettingsView({ basePath = "/settings", section = "appearance", planning }: { basePath?: string; section?: SettingsSection; planning?: ReactNode } = {}) {
  return <div className="min-w-0 bg-bg">
    <PageHeading title="设置" />
    <SettingsHashRedirect basePath={basePath} />
    <div className="mx-auto max-w-[1040px] px-5 py-5 lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:items-start lg:gap-10">
      <nav aria-label="设置分区" className="mb-5 flex gap-1 overflow-x-auto lg:flex-col">
        {sections.map(item => <Link key={item.id} href={`${basePath}${item.suffix}`} aria-current={section === item.id ? "page" : undefined}
          className={`inline-flex min-h-11 shrink-0 items-center rounded-ctl px-3 text-sm focus-visible:ring-2 focus-visible:ring-accent ${section === item.id ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2"}`}>{item.label}</Link>)}
      </nav>
      <div className="min-w-0 space-y-6">
        {section === "appearance" ? <AppearanceSettings /> : section === "learning" ? <LearningSettingsSection planning={planning} /> : <>
          <section id="connections" className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
            <Link className={ui.secondary} href={`${basePath}/connections`}>连接管理</Link>
            <Link className={ui.secondary} href={`${basePath}/export`}>导出数据</Link>
            <a className={ui.quiet} href="#daily-budget">每日用量</a>
          </section>
          <DiagnosticsSettings />
          <AdvancedSettingsView basePath={basePath} embedded />
        </>}
      </div>
    </div>
  </div>;
}
export function LearningSettingsSection({ planning }: { planning?: ReactNode } = {}) {
  const [learningPreferences, setLearningPreferences] = useState<LearningPreferences>(disabledLearningPreferences);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setReady(false);
    setError("");
    try {
      const body = await fetchWorkspacePreferences();
      setLearningPreferences(body.learningPreferences ?? disabledLearningPreferences);
      setReady(true);
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
    if (!ready || loading || saving) return;
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

  return <div className="space-y-6">
        <section id="preferences" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="learning-preferences-heading">
          <div>
            <h2 className="text-sm font-medium text-text" id="learning-preferences-heading">学习偏好</h2>
            <p className="mt-1 text-xs leading-6 text-text-3">评价、补测与提醒，直接影响学习闭环。</p>
          </div>
          <div className="space-y-3">
            {loading ? <LoadingRows label="正在读取设置" /> : null}
            {error ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-danger/25 bg-danger/10 p-3" role="alert">
                <p className="text-sm text-danger">{error}</p>
                <button className={ui.secondary} onClick={() => void loadSettings()} type="button">
                  <RefreshCw aria-hidden="true" size={14} />重新读取
                </button>
              </div>
            ) : null}
            {!loading && ready ? (
              <>
                <div className="divide-y divide-line">
                  {learningSwitches.map(({ key, label }) => (
                    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm text-text-2 focus-within:ring-2 focus-within:ring-accent" key={key}>
                      <span>{label}</span>
                      <input
                        checked={learningPreferences[key]}
                        className="size-6 accent-accent"
                        disabled={saving || (key !== "assessmentEnabled" && key !== "autoGradeOnSave" && !learningPreferences.assessmentEnabled)}
                        onChange={(event) => setLearningPreferences((current) =>
                          key === "assessmentEnabled" && !event.target.checked
                            ? { ...disabledLearningPreferences, autoGradeOnSave: current.autoGradeOnSave }
                            : { ...current, [key]: event.target.checked },
                        )}
                        type="checkbox"
                      />
                    </label>
                  ))}
                </div>
                <p className="text-xs leading-6 text-text-3">首次提交自动批改独立于自动评价；关闭不影响手动批改。改答案后需手动重新批改；无可用模型或达到每日自动额度时只保存答案。</p>
                <button className={ui.primary} disabled={saving || !ready} onClick={() => void saveLearningPreferences()} type="button">
                  {saving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} /> : <Save aria-hidden="true" size={14} />}
                  保存学习偏好
                </button>
              </>
            ) : null}
          </div>
        </section>

        <section className="grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="learning-test-heading">
          <div>
            <h2 className="text-sm font-medium text-text" id="learning-test-heading">学习测试</h2>
            <p className="mt-1 text-xs leading-6 text-text-3">自愿参加小单元练习与延迟复测，用真实作答检查学习判断是否准确。</p>
          </div>
          <div>
            <Link className={ui.secondary} href="/opening/settings/learning-test">打开学习测试</Link>
          </div>
        </section>


        <section id="intervention" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="intervention-preferences-heading">
          <div>
            <h2 className="text-sm font-medium text-text" id="intervention-preferences-heading">教学介入偏好</h2>
            <p className="mt-1 text-xs leading-6 text-text-3">选择主动提醒的程度；你主动提问时始终可以获得帮助。</p>
          </div>
          <div className="min-w-0">
            <PreferenceControls scope="global" simplified />
          </div>
        </section>

        <section id="planning" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="opening-planning-heading">
          <div>
            <h2 className="text-sm font-medium text-text" id="opening-planning-heading">开学排程</h2>
            <p className="mt-1 text-xs leading-6 text-text-3">导入课表并确认学期设置后，可在学习安排里调整可用时间和任务。</p>
          </div>
          <div className="space-y-8">
            {planning ?? <Link className={ui.secondary} href="/opening/settings/learning?planning=1#planning">调整学习安排</Link>}
            <SemesterSettingsForm />
            <TimetableImport />
          </div>
        </section>

    {notice ? <p className="text-sm text-accent" role="status">{notice}</p> : null}
  </div>;
}
