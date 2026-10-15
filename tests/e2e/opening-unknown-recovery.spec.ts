import { expect, test, type Page } from "@playwright/test";
import type { TurnInput, TurnRecord } from "@aistudy/contracts";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";
import { resetE2eDatabase } from "../../scripts/db-reset-e2e";

const conversationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const newJobId = "33333333-3333-4333-8333-333333333333";
const updatedAt = "2026-10-15T00:00:00.000Z";
const question = "请给我一个关于导数的提示";

/** Transport fixtures exercise UI recovery without dispatching a model or changing its ledger. */
async function unknownConversation(page: Page, { newerAnswerDuringPoll = false, changeDuringRecovery = false } = {}) {
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
      { ...turns[0]!, id: "66666666-6666-4666-8666-666666666666", text: input.text, mode: input.mode },
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
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error("E2E_DATABASE_URL is required for the isolated recovery suite");
  await resetE2eDatabase(url);
  await seedOpeningOwner();
});
test.beforeEach(async ({ context, baseURL }) => { await loginOpeningOwner(context.request, baseURL!); });

test("unknown recovery waits from the server timestamp across refresh, then only prefills until explicit send", async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(updatedAt) - 1_000) });
  await page.clock.pauseAt(new Date(updatedAt));
  const fixture = await unknownConversation(page);
  await page.goto("/opening/assistant");
  await expect(page.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
  await page.clock.fastForward(20_000);
  await page.reload();
  await expect(page.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  await page.clock.fastForward(39_999);
  await expect(page.getByRole("button", { name: "稍后重新提问", exact: true })).toBeDisabled();
  expect(fixture.submitted).toHaveLength(0);
  await page.clock.fastForward(1);
  const retry = page.getByRole("button", { name: "重新提问", exact: true });
  await expect(retry).toBeEnabled();
  expect(fixture.counts()).toEqual({ conversationCreates: 0, jobReads: 0 });
  await retry.click();
  await page.clock.runFor(16);
  await expect(page.getByRole("textbox", { name: "消息输入" })).toHaveValue(question);
  await expect(page.getByRole("combobox", { name: "辅导模式" })).toHaveValue("hint");
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeFocused();
  expect(fixture.submitted).toHaveLength(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
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
  await page.goto("/opening/assistant");
  const draft = page.getByRole("textbox", { name: "消息输入" });
  await expect(draft).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await draft.fill("保留我的新草稿");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "重新提问", exact: true }).click();
  await expect(draft).toHaveValue("保留我的新草稿");
  expect(fixture.submitted).toHaveLength(0);
  fixture.finishNewTurn();
  await page.reload();
  await expect(page.getByRole("log").getByText("新回答", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(draft).toBeEnabled();
  expect(fixture.submitted).toHaveLength(0);
});

test("a late unknown poll cannot replace the latest completed conversation state", async ({ page }) => {
  const fixture = await unknownConversation(page, { newerAnswerDuringPoll: true });
  await page.goto("/opening/assistant");
  await expect(page.getByRole("log").getByText("新回答", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  expect(fixture.counts().jobReads).toBe(1);
  expect(fixture.submitted).toHaveLength(0);
});

test("a different latest job during recovery requires a fresh read instead of offering an unrelated question", async ({ page }) => {
  const fixture = await unknownConversation(page, { changeDuringRecovery: true });
  await page.goto(`/opening/assistant?conversation=${conversationId}`);
  await expect(page.getByText("对话刚刚发生变化，请重新读取后再恢复提问。", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "回答恢复" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
  expect(fixture.submitted).toHaveLength(0);
});
