import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.skip(process.env.OPENING_E2E !== "1", "requires the isolated Opening configuration and fixture provider");
test.beforeAll(async () => { await seedOpeningOwner(); });
test("real upload and PDF parser feed cited tutor transport, then survive an in-flight refresh (fixture model)", async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL });
  try {
    await loginOpeningOwner(context.request, baseURL!);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/opening/assistant");
    const fixture = path.resolve("tests/fixtures/opening/parser-two-page.pdf");
    await page.getByLabel("选择文件或拍照").setInputFiles(fixture);
    const sourceRow = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "parser-two-page.pdf" }) });
    await expect(sourceRow).toBeVisible();
    // No reload or direct DB write is allowed to make the source become selectable.
    const choice = page.getByRole("checkbox", { name: /parser-two-page.pdf/ });
    await expect(choice).toBeVisible({ timeout: 120_000 });
    await choice.check();
    await page.getByLabel("当前物理页码").fill("1");
    await page.getByLabel("消息输入").fill("Summarize the selected page.");
    const submitted = page.waitForResponse((response) => response.url().endsWith("/api/opening/turns") && response.request().method() === "POST");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const accepted = await submitted;
    expect(accepted.status()).toBe(201);
    await page.reload();
    await expect(page.getByRole("log").getByText("[测试模型] 已收到原件第一页文本 page one。", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(choice).toBeChecked();
    await expect(page.getByLabel("当前物理页码")).toHaveValue("1");
    const citation = page.getByRole("log").getByRole("link", { name: /v0/ }).first();
    await expect(citation).toHaveAttribute("href", /\/api\/opening\/sources\/[0-9a-f-]+\/download\?version=0$/);
    const ticketResponse = await context.request.get((await citation.getAttribute("href"))!);
    expect(ticketResponse.status()).toBe(200);
    const ticket = await ticketResponse.json();
    expect(ticket.version).toBe(0);
    const bytes = await context.request.get(ticket.url);
    expect(bytes.status()).toBe(200);
    expect(await bytes.body()).toEqual(await readFile(fixture));
    const stats = await (await context.request.get("http://127.0.0.1:18081/stats")).json();
    expect(stats.calls).toBe(1);
    await page.reload();
    await expect(page.getByRole("log").getByText("Summarize the selected page.", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("log").getByText("[测试模型] 已收到原件第一页文本 page one。", { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("workflow-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("消息输入")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("workflow-mobile.png"), fullPage: true });
  } finally { await context.close(); }
});
