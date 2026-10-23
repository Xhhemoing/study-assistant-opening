"use client";

import type { LearningPreferences } from "@aistudy/contracts";
import { LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SemesterSettingsForm } from "../opening/timetable/semester-settings-form";
import { TimetableImport } from "../opening/timetable/timetable-import";
import {
  disabledLearningPreferences,
  fetchWorkspacePreferences,
  learningSwitches,
  putWorkspacePreferences,
} from "./settings-shared";
import { PreferenceControls } from "../opening/teaching/preference-controls";
import { QuickSetupPanel } from "./quick-setup-panel";
import { AppearanceSettings } from "../opening/settings/appearance-settings";

const navLinkClass = "inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-ctl px-3 text-ui text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:min-h-8";

export function SettingsView({ basePath = "/settings" }: { basePath?: string } = {}) {
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

  return (
    <div className="min-w-0 bg-bg">
      <PageHeading title="设置" />
      <div className="mx-auto max-w-[1040px] px-5 py-5 lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:items-start lg:gap-10">
        <nav aria-label="设置分区" className="sticky top-[var(--topbar-h,52px)] z-10 -mx-5 mb-4 flex gap-1 overflow-x-auto bg-bg/90 px-5 py-2 backdrop-blur [scrollbar-width:none] lg:mx-0 lg:mb-0 lg:flex-col lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none">
          <a className={navLinkClass} href="#appearance">外观与阅读</a>
          <a className={navLinkClass} href="#quick-model-setup">AI 快速配置</a>
          <a className={navLinkClass} href="#connections">连接</a>
          <a className={navLinkClass} href="#planning">排程</a>
          <a className={navLinkClass} href="#preferences">学习偏好</a>
          <a className={navLinkClass} href="#intervention">介入偏好</a>
          <Link className={navLinkClass} href="/opening/settings/learning-test">学习测试</Link>
          <Link className={navLinkClass} href={`${basePath}/advanced`}>高级</Link>
          <Link className={navLinkClass} href={`${basePath}/advanced#daily-budget`}>每日 AI 用量</Link>
        </nav>
        <div className="min-w-0 space-y-6">

        <AppearanceSettings />

        <QuickSetupPanel basePath={basePath} />

        <section id="connections" className="scroll-mt-6 border-b border-line pb-6" aria-labelledby="opening-connections-heading">
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div>
              <h2 className="text-sm font-medium text-text" id="opening-connections-heading">数据连接</h2>
              <p className="mt-1 text-xs leading-6 text-text-3">邮箱与钉钉授权、暂停、撤销与手工导入请在连接页管理。</p>
            </div>
            <div>
              <Link className={ui.secondary} href="/opening/settings/connections">打开连接设置</Link>
            </div>
          </div>
        </section>

        <section id="planning" className="scroll-mt-6 grid gap-4 border-b border-line pb-6 sm:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby="opening-planning-heading">
          <div>
            <h2 className="text-sm font-medium text-text" id="opening-planning-heading">开学排程</h2>
            <p className="mt-1 text-xs leading-6 text-text-3">导入课表并确认学期设置后，可在学习安排里调整可用时间和任务。</p>
          </div>
          <div className="space-y-8">
            <Link className={ui.secondary} href="/opening/settings/planning">打开学习安排</Link>
            <SemesterSettingsForm />
            <TimetableImport />
          </div>
        </section>

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
                        disabled={saving || (key !== "assessmentEnabled" && !learningPreferences.assessmentEnabled)}
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
            <p className="mt-1 text-xs leading-6 text-text-3">主动提示程度与安静模式。嵌在现有设置中，不是第二套设置产品。本课临时覆盖请在教学工作台调整。</p>
          </div>
          <div className="min-w-0">
            <PreferenceControls scope="global" />
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs leading-6 text-text-3">AI 模型与每日额度、默认入口、指导模式、计划自主权、导出与诊断等在高级设置。</p>
          <div className="flex flex-wrap gap-2">
            <Link className={ui.secondary} href={`${basePath}/advanced#daily-budget`}>AI 模型与每日额度</Link>
            <Link className={ui.secondary} href={`${basePath}/advanced`}>打开高级设置</Link>
          </div>
        </div>

        {notice ? <p className="text-sm text-accent" role="status">{notice}</p> : null}
        </div>
      </div>
    </div>
  );
}
