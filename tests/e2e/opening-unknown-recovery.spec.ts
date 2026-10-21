import { expect, test, type Page } from "./fixtures";
import type { TurnInput, TurnRecord } from "@aistudy/contracts";
import { inferComposerIntent } from "../../packages/domain/src/opening/composer-intent";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";
import { buildAiReadinessItems } from "../../packages/ai/src/opening/ai-readiness";

const conversationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const newJobId = "33333333-3333-4333-8333-333333333333";
const updatedAt = "2026-10-15T00:00:00.000Z";
const question = "请给我一个关于导数的提示";

async function openAssistant(page: Page, conversation?: string) {
  await page.goto(`/opening/assistant${conversation ? `?conversation=${conversation}` : ""}`);
  await expect(page).toHaveURL(url => url.pathname === "/opening/today" && url.searchParams.get("ai") === "1" && url.searchParams.get("conversation") === (conversation ?? null));
  const assistant = page.getByRole("dialog", { name: "学习助手", exact: true });
  await expect(assistant).toBeVisible();
  return assistant;
}

/** Transport fixtures exercise UI recovery without dispatching a model or changing its ledger. */
async function unknownConversation(page: Page, { newerAnswerDuringPoll = false, changeDuringRecovery = false } = {}) {
  // Recovery transport assumes a configured text tutor; no real model is dispatched.
  await page.route("**/api/opening/ai-readiness", route => route.fulfill({ json: {
    items: buildAiReadinessItems({ keyedModelCount: 1, pricingConfigured: true, effectiveCapCents: 100,
      usedCents: 0, remainingCents: 100, reconciledUnknownCount: 0, visionAvailable: false,
      parserOcrReady: false, workerOk: true, workerDetail: "Recovery transport fixture", availableModelCount: 1 }),
  } }));
  const submitted: TurnInput[] = [];
  let conversationCreates = 0;
  let jobReads = 0;
  let recoveryReads = 0;
  let completed = false;
  const turns: TurnRecord[] = [
    { id: "44444444-4444-4444-8444-444444444444", conversationId, role: "user", text: question, citations: [], createdAt: "2026-10-14T23:55:00.000Z", mode: "hint", status: "complete" },
    { id: "55555555-5555-4555-8555-555555555555", conversationId, role: "assistant", text: "provider outcome unknown; usage reconciliation pending", citations: [], createdAt: "2026-10-14T23:55:00.001Z", mode: "hint", status: "outcome_unknown" },
  ];
  if (newerAnswerDuringPoll) turns[1]!.status = "pending";
  const finishNewTurn = () => {
    completed = true;
    turns.push({ ...turns[0]!, id: "99999999-9999-4999-8999-999999999999", text: "新问题" }, { ...turns[1]!, status: "complete", text: "新回答", id: "88888888-8888-4888-8888-888888888888" });
  };
  await page.route(/\/api\/opening\/conversations(?:\/|$)/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/opening/conversations") {
      if (route.request().method() === "POST") {
        conversationCreates += 1;
        await route.fulfill({ json: { id: conversationId, title: "恢复测试", courseId: null } });
      } else {
        await route.fulfill({ json: [{ id: conversationId, title: "恢复测试", courseId: null, updatedAt, lastTurnPreview: question }] });
      }
    } else if (path.endsWith("/resume")) {
      await route.fulfill({ json: { conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false } });
    } else if (path.endsWith("/turns")) {
      await route.fulfill({ json: turns });
    } else if (path.endsWith("/pending-job")) {
      const response = completed ? null : submitted.length ? { id: newJobId, status: "queued", error: null, updatedAt } : { id: jobId, status: newerAnswerDuringPoll ? "running" : "outcome_unknown", error: { message: "provider timeout" }, updatedAt };
      recoveryReads += 1;
      if (changeDuringRecovery && recoveryReads === 1) finishNewTurn();
      await route.fulfill({ json: response });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/opening/turns", async route => {
    const input = route.request().postDataJSON() as TurnInput;
    submitted.push(input);
    turns.push(
      { ...turns[0]!, id: "66666666-6666-4666-8666-666666666666", text: input.text, mode: inferComposerIntent(input).mode },
      { ...turns[1]!, id: "77777777-7777-4777-8777-777777777777", status: "pending", text: "" },
    );
    await route.fulfill({ status: 201, json: { jobId: newJobId, turnId: turns.at(-1)!.id } });
  });
  await page.route("**/api/opening/jobs/*", async route => {
    jobReads += 1;
    if (newerAnswerDuringPoll) {
      finishNewTurn();
      await route.fulfill({ json: { id: jobId, status: "outcome_unknown", error: { message: "provider timeout" }, updatedAt } });
    } else {
      await route.fulfill({ json: { id: newJobId, status: "queued", error: null, updatedAt } });
    }
  });
  return {
    submitted,
    counts: () => ({ conversationCreates, jobReads }),
    finishNewTurn,
  };
}

test.beforeAll(async () => {
  await seedOpeningOwner();
});
test.beforeEach(async ({ context, baseURL }) => { await loginOpeningOwner(context.request, baseURL!); });

test("unknown recovery waits from the server timestamp across refresh, then only prefills until explicit send", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(updatedAt) - 1_000) });
  await page.clock.pauseAt(new Date(updatedAt));
  const fixture = await unknownConversation(page);
  const assistant = await openAssistant(page);
  await expect(assistant.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  await expect(assistant.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
  await page.clock.fastForward(20_000);
  await page.reload();
  await expect(assistant.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  await page.clock.fastForward(39_999);
  await expect(assistant.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  expect(fixture.submitted).toHaveLength(0);
  await page.clock.fastForward(1);
  const retry = assistant.getByRole("button", { name: "重新提问", exact: true });
  await expect(retry).toBeEnabled();
  expect(fixture.counts()).toEqual({ conversationCreates: 0, jobReads: 0 });
  await retry.click();
  await page.clock.runFor(16);
  await expect(assistant.getByRole("textbox", { name: "消息输入" })).toHaveValue(question);
  await expect(assistant.getByRole("textbox", { name: "消息输入" })).toBeFocused();
  await expect(assistant.getByText("只给提示", { exact: true })).toBeVisible();
  await expect(assistant.getByRole("button", { name: "撤回本轮选择，恢复自动判断", exact: true })).toBeEnabled();
  await expect(assistant.getByRole("combobox", { name: "辅导模式" })).toHaveCount(0);
  expect(fixture.submitted).toHaveLength(0);
  await assistant.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => fixture.submitted.length).toBe(1);
  expect(fixture.submitted[0]).toMatchObject({ conversationId, text: question, mode: "hint", privacy: "saved" });
  expect(fixture.submitted[0]!.clientKey).toMatch(/^ck-/);
  expect(fixture.counts().conversationCreates).toBe(0);
});

test("manual retry protects an unsent draft and does not restore an old unknown after a newer completed turn", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date(Date.parse(updatedAt) + 59_000) });
  await page.clock.pauseAt(new Date(Date.parse(updatedAt) + 60_000));
  const fixture = await unknownConversation(page);
  const assistant = await openAssistant(page);
  const draft = assistant.getByRole("textbox", { name: "消息输入" });
  await expect(draft).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await draft.fill("保留我的新草稿");
  page.once("dialog", dialog => dialog.dismiss());
  await assistant.getByRole("button", { name: "重新提问", exact: true }).click();
  await expect(draft).toHaveValue("保留我的新草稿");
  expect(fixture.submitted).toHaveLength(0);
  fixture.finishNewTurn();
  await page.reload();
  await expect(assistant.getByRole("log").getByText("新回答", { exact: true })).toBeVisible();
  await expect(assistant.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(draft).toBeEnabled();
  expect(fixture.submitted).toHaveLength(0);
});

test("a late unknown poll cannot replace the latest completed conversation state", async ({ page }) => {
  const fixture = await unknownConversation(page, { newerAnswerDuringPoll: true });
  const assistant = await openAssistant(page);
  await expect(assistant.getByRole("log").getByText("新回答", { exact: true })).toBeVisible();
  await expect(assistant.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(assistant.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  expect(fixture.counts().jobReads).toBe(1);
  expect(fixture.submitted).toHaveLength(0);
});

test("a different latest job during recovery requires a fresh read instead of offering an unrelated question", async ({ page }) => {
  const fixture = await unknownConversation(page, { changeDuringRecovery: true });
  const assistant = await openAssistant(page, conversationId);
  await expect(assistant.getByText("对话刚刚发生变化，请重新读取后再恢复提问。", { exact: true })).toBeVisible();
  await expect(assistant.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(assistant.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
  expect(fixture.submitted).toHaveLength(0);
});
