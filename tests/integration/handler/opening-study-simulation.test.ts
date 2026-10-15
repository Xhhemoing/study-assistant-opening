/**
 * Study simulation (exploratory): a learner replaces lectures with the app for
 * Math I Unit 8 — 3–5 lessons a day. Drives the real route handlers and the real
 * compile worker; only the model is replaced by a scripted teacher. Writes a
 * journal of what the program decided on its own and where the learner had to.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository,
  type OpeningJobRecord,
} from "@aistudy/database";
import type { ProviderInput } from "@aistudy/ai";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { GET as listTasks } from "../../../apps/web/src/app/api/opening/tasks/route";
import { PATCH as patchTask } from "../../../apps/web/src/app/api/opening/tasks/[id]/route";
import { PUT as putSettings } from "../../../apps/web/src/app/api/opening/planning-settings/route";
import { PUT as putStudyPlan } from "../../../apps/web/src/app/api/opening/courses/[id]/study-plan/route";
import { POST as createActivity } from "../../../apps/web/src/app/api/opening/teaching-activities/route";
import { PATCH as setStatus } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/status/route";
import { GET as getSummary } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/summary/route";
import { GET as getAnswerKey } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/answer-key/route";
import { GET as getClientInit } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route";
import { POST as createSession } from "../../../apps/web/src/app/api/opening/learning-sessions/route";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as reviseObservation } from "../../../apps/web/src/app/api/opening/observations/revisions/route";
import { buildSelfCompareRevision } from "../../../apps/web/src/features/opening/learning/reference-check";
import { buildSeedSettings } from "../../../apps/web/src/features/opening/planning/seed-today-plan";
import { buildStartLearningCreateInput } from "../../../apps/web/src/features/opening/teaching/today-activity";
import { createCompileTeachingUnitHandler } from "../../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { UNIT8_PAGES } from "./fixtures/unit8-teacher";

const PAGES_DIR = process.env.SIM_UNIT8_DIR;
const LOG = process.env.SIM_LOG;
const journal: string[] = [];
const say = (line: string) => { journal.push(line); };

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, url = "https://localhost/api/opening/x") =>
  new Request(url, { method, headers: { cookie: f.cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** The scripted teacher: answers the compile prompt from the pages it was given. */
const prompts: string[] = [];
function teacher(input: ProviderInput) {
  prompts.push(input.text);
  const found = [...input.text.matchAll(/\[source \S+ v\d+ page (\d+) chunk (\S+) —/g)].map((m) => ({ page: Number(m[1]), chunkId: m[2]! }));
  const review = input.text.includes("综合复习");
  const lessons = found.map((hit) => ({ ...UNIT8_PAGES.find((p) => p.page === hit.page)!, chunkId: hit.chunkId }));
  const outlineItems = (/--- OUTLINE JSON ---\n(.*)\n/.exec(input.text)?.[1] ?? "{\"items\":[]}");
  const items = (JSON.parse(outlineItems) as { items: Array<{ itemId: string }> }).items;
  const focus = Math.max(0, items.findIndex((item) => item.itemId === /focusItemId=(\S+)/.exec(input.text)?.[1]));
  const blocks: Array<Record<string, unknown>> = [];
  const teach = review ? lessons.filter((l) => l.question).slice(0, 3) : lessons.slice(0, 6);
  for (const l of teach) blocks.push({ type: l.type, text: l.text, citedChunkIds: [l.chunkId], ...(l.quote ? { quote: l.quote } : {}) });
  const asked = lessons.filter((l) => l.question).slice(review ? 0 : -2);
  // Planned review: a teacher re-asks (a variant of) each listed wrong answer first.
  const wrong = [...input.text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
  for (const stem of wrong) {
    const page = UNIT8_PAGES.find((p) => p.question && stem.includes(p.question.prompt.slice(0, 20)));
    const hit = page && found.find((x) => x.page === page.page);
    blocks.push({ type: "prompt", text: `类似题：${stem}`, citedChunkIds: hit ? [hit.chunkId] : [] });
    blocks.push({ type: "answer_key", text: page?.question?.answer ?? "见上一课讲解。", citedChunkIds: hit ? [hit.chunkId] : [] });
  }
  for (const l of asked) {
    blocks.push({ type: "prompt", text: l.question!.prompt, citedChunkIds: [l.chunkId] });
    blocks.push({ type: "answer_key", text: l.question!.answer, citedChunkIds: [l.chunkId] });
  }
  const headings = teach.map((l) => l.heading);
  const itemTitles = items.map((_, i) => (i === focus ? headings.join(" · ").slice(0, 80) || "复习" : `第 ${i + 1} 部分`));
  return {
    text: JSON.stringify({ itemTitles, blocks }),
    citedChunkIds: [...new Set(lessons.map((l) => l.chunkId))],
    requestId: null, candidates: [], inputTokens: input.text.length, outputTokens: 800,
  };
}

async function runCompileJobs(activityId: string) {
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
    budget: createOpeningBudgetRepository(f.sql, { envCapCents: 1_000_000 }),
    chunks: createOpeningSourceChunksRepository(f.sql),
    privacy: createOpeningPrivacyRepository(f.sql),
  });
  deps.callModel = async (_scope, input) => teacher(input) as never;
  const run = createCompileTeachingUnitHandler(deps);
  const rows = await f.sql<Array<{ id: string; key: string; kind: string; payload: unknown; privacy_epoch: number }>>`
    SELECT id, key, kind, payload, privacy_epoch FROM opening_jobs
    WHERE kind='compile-teaching-unit' AND payload->>'activityId'=${activityId} AND state='queued'`;
  for (const row of rows) {
    await f.sql`UPDATE opening_jobs SET state='running' WHERE id=${row.id}`;
    const job: OpeningJobRecord = { id: row.id, workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId, key: row.key, kind: row.kind, payload: row.payload, result: null, state: "running", privacyEpoch: row.privacy_epoch };
    try { await run(job, row.payload); await f.sql`UPDATE opening_jobs SET state='succeeded' WHERE id=${row.id}`; }
    catch (error) { say(`  ✗ 备课失败：${(error as Error).message}`); }
  }
}

type Block = { blockId: string; blockType: string; role: string; content: Record<string, unknown> | null };
async function studyLesson(activity: { id: string; courseId: string | null; sourceIds: string[] }, courseId: string, sourceId: string, mistakes: Set<number>, label: string) {
  await runCompileJobs(activity.id);
  const initRes = await getClientInit(req("GET"), ctx(activity.id));
  const init = await initRes.json() as { blocks?: Block[]; sourceRefs?: Array<{ page?: number | null }>; generationConfig?: unknown };
  const [state] = await f.sql<Array<{ generate_status: string; content_version: number }>>`SELECT generate_status, content_version FROM opening_teaching_activities WHERE id=${activity.id}`;
  const pages = [...new Set((init.sourceRefs ?? []).map((r) => r.page).filter((p): p is number => p != null))].sort((a, b) => a - b);
  const quotes = (init.blocks ?? []).filter((b) => typeof b.content?.sourceQuote === "string").length;
  const teachBlocks = (init.blocks ?? []).filter((b) => b.role === "teach" || b.role === "example").length;
  const questions = (init.blocks ?? []).filter((b) => b.role === "prompt");
  say(`  ${label}：状态 ${state?.generate_status}；讲第 ${pages.join(",") || "?"} 页；讲解块 ${teachBlocks}，带原文 ${quotes}，练习 ${questions.length}`);
  if (state?.generate_status !== "ready" && state?.generate_status !== "needs_check") return null;

  const session = await (await createSession(req("POST", { activityId: activity.id, courseId, skillLabel: label.slice(0, 200), sourceIds: [sourceId] }))).json() as { id: string };
  let answered = 0;
  for (const [index, q] of questions.entries()) {
    const prompt = String(q.content?.text ?? q.content?.prompt ?? "");
    const attemptRes = await createAttempt(req("POST", { sessionId: session.id, clientKey: `a-${randomUUID()}`, teachingBlock: { blockId: q.blockId, contentVersion: state.content_version }, problem: { sourceId, stemSnapshot: prompt.slice(0, 500), artifactKind: "reference_item" } }));
    if (attemptRes.status !== 201) { say(`    作答创建失败 ${attemptRes.status} ${await attemptRes.text()}`); continue; }
    const attempt = await attemptRes.json() as { id: string };
    const observation = await (await submitAttempt(req("POST", { clientKey: `s-${randomUUID()}`, answer: "我的作答", outcome: "unverified", assistance: "independent", verdictSource: "self_report" }), ctx(attempt.id))).json();
    const keyRes = await getAnswerKey(new Request(`https://localhost/x?${new URLSearchParams({ blockId: q.blockId, attemptId: attempt.id })}`, { headers: { cookie: f.cookie } }), ctx(activity.id));
    const key = keyRes.status === 200 ? await keyRes.json() as { answer: string; referenceSourceId: string | null } : null;
    const wrong = mistakes.has(index);
    if (key?.referenceSourceId) {
      const revised = await reviseObservation(req("POST", buildSelfCompareRevision({ observation, choice: wrong ? "mismatch" : "match", referenceSourceId: key.referenceSourceId, clientKey: `c-${randomUUID()}` })));
      if (revised.status !== 201) say(`    核对失败 ${revised.status} ${(await revised.text()).slice(0, 200)}`);
    }
    say(`    题 ${index + 1}：参考答案${key ? "可见" : `不可见(${keyRes.status})`}，自评${wrong ? "答错" : "答对"}`);
    answered += 1;
  }
  await setStatus(req("PATCH", { status: "completed" }), ctx(activity.id));
  const summary = await (await getSummary(req("GET"), ctx(activity.id))).json() as { attempts?: unknown; openQuestions?: unknown };
  say(`    小结：${JSON.stringify(summary.attempts)}；待核对 ${JSON.stringify(summary.openQuestions)}`);
  return answered;
}

async function today(date: string) {
  const body = await (await getToday(req("GET", undefined, `https://localhost/api/opening/today?date=${date}`))).json() as Record<string, unknown>;
  const all = (await (await listTasks(req("GET"))).json() as { tasks: Array<Record<string, unknown>> }).tasks;
  const titles = new Map(all.map((t) => [t.id, t.title]));
  const draft = body.dailyDraft as { status: string; blocks: Array<{ taskId: string; start: string; end: string }>; unscheduledTaskIds: string[] } | null;
  say(`【${date} 今日页】待办任务：${JSON.stringify(all.filter((t) => t.status === "pending").map((t) => `${t.title}(${t.minutes}分,${t.origin})`))}`);
  say(`  自动草案：${draft ? `${draft.status}，${draft.blocks.map((b) => `${String(b.start).slice(11, 16)}Z ${titles.get(b.taskId)}`).join("；") || "无块"}` : `无（${String(body.dailyDraftSkippedReason)}）`}`);
  return body;
}

beforeAll(async () => {
  Object.assign(process.env, { OPENING_TEACHING_COMPILER_ENABLED: "1", OPENING_TEACHING_VALIDATION_ENABLED: "1", OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" });
  f = await createOpeningFixture();
  await f.reset();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => {
  if (LOG) writeFileSync(LOG, `${journal.join("\n")}\n\n=== prompts ===\n${prompts.map((p) => p.split("--- OUTLINE JSON ---")[0]).join("\n----\n")}`);
  setAuthRuntimeForTests(null); await runtime?.close(); await f?.close();
});

async function seedCourse() {
  // Course + uploaded, parsed slides (one chunk per page, as the parser emits).
  const courseId = randomUUID(), sourceId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseId}, ${f.scope.workspaceId}, 'Math I · 第 8 单元', ${courseId})`;
  await f.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${f.scope.workspaceId}, 'Pres-Unit8.pdf', 'application/pdf', 1000, ${"a".repeat(64)}, 1, 'uploaded', 'ready')`;
  for (let page = 1; page <= 21; page += 1) {
    await f.sql`INSERT INTO opening_source_chunks (source_id, source_version, page, text) VALUES (${sourceId}, 1, ${page}, ${readFileSync(`${PAGES_DIR}/p${page}.txt`, "utf8")})`;
  }
  await f.sql`INSERT INTO course_asset_memberships (course_id, workspace_id, asset_type, asset_id, role, sort_order, visibility) VALUES (${courseId}, ${f.scope.workspaceId}, 'source', ${sourceId}, 'core', 0, 'private')`;
  return { courseId, sourceId };
}

/** Lessons finish on the simulated day (the program reads progress from completion times). */
async function onDay(date: string, activityId: string) {
  const at = `${date}T10:00:00+08:00`;
  await f.sql`UPDATE opening_teaching_activities SET created_at=${at}, updated_at=${at} WHERE id=${activityId}`;
  await f.sql`UPDATE opening_learning_attempts SET started_at=${`${date}T10:05:00+08:00`} WHERE activity_id=${activityId}`;
}

describe.skipIf(!PAGES_DIR)("Unit 8 study simulation", () => {
  it("with a study plan: the learner only opens Today and studies what it lists", async () => {
    const { courseId, sourceId } = await seedCourse();
    const day1 = "2026-10-15";
    say("课程 Math I · 第 8 单元，讲义 21 页已解析。学习者：每天 4 节课（每节 45 分钟），代替老师授课；截止 10-18。");
    await putSettings(req("PUT", buildSeedSettings(new Date(`${day1}T08:00:00+08:00`))));
    const planRes = await putStudyPlan(req("PUT", { plan: { lessonsPerDay: 4, lessonMinutes: 45, startDate: day1 }, targetDate: "2026-10-18" }), ctx(courseId));
    const view = await planRes.json() as { lessons: Array<{ number: number; title: string; pageFrom: number; pageTo: number; status: string; date: string }>; finishDate: string; behind: boolean; reviewDates: string[] };
    say(`课程页「制定学习计划」(${planRes.status})：共 ${view.lessons.length} 课，预计 ${view.finishDate} 学完新内容${view.behind ? "（赶不上截止日）" : "（截止日前可完成）"}；复习日 ${view.reviewDates.join(",")}`);
    for (const lesson of view.lessons) say(`  第 ${lesson.number} 课 ${lesson.date} [${lesson.status}] 第 ${lesson.pageFrom}–${lesson.pageTo} 页：${lesson.title}`);

    const days = ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-22"];
    for (const [d, date] of days.entries()) {
      await today(date);
      const all = (await (await listTasks(req("GET"))).json() as { tasks: Array<{ id: string; title: string; status: string; version: number; priority: number; studyPlan?: { kind: string; localDate: string } }> }).tasks;
      const queue = all.filter((t) => t.status === "pending" && t.studyPlan).sort((a, b) => b.priority - a.priority);
      for (const [n, task] of queue.entries()) {
        const activity = await (await createActivity(req("POST", buildStartLearningCreateInput({ localDate: date, taskId: task.id, courseId, courseTitle: task.title })))).json() as { id: string; courseId: string | null; sourceIds: string[] };
        // Day 1, second lesson: the learner gets the first question wrong; day 2 review: wrong again once.
        const mistakes = new Set((d === 0 && n === 1) || (d === 1 && n === 0) ? [0] : []);
        await studyLesson(activity, courseId, sourceId, mistakes, `${date} ${task.studyPlan?.kind === "review" ? "复习" : "新课"}「${task.title.replace("Math I · 第 8 单元 · ", "")}」`);
        await onDay(date, activity.id);
        const fresh = (await (await listTasks(req("GET"))).json() as { tasks: Array<{ id: string; version: number }> }).tasks.find((t) => t.id === task.id)!;
        await patchTask(req("PATCH", { status: "done", expectedVersion: fresh.version, at: new Date(`${date}T12:00:00+08:00`).toISOString() }), ctx(task.id));
      }
    }
    const [cards] = await f.sql`SELECT count(*)::int AS n FROM cards WHERE workspace_id=${f.scope.workspaceId}`;
    say(`结束：记忆卡片 ${cards!.n} 张`);
    expect(journal.length).toBeGreaterThan(5);
  }, 240_000);
});
