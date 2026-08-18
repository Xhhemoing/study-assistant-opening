import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const choiceId = "22222222-2222-4222-8222-222222222201";
const shortId = "22222222-2222-4222-8222-222222222209";
const checkpointId = "22222222-2222-4222-8222-22222222220f";

async function register(context: BrowserContext, label: string) {
  const response = await context.request.post("/api/auth/register", {
    data: {
      email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "password123",
      displayName: label,
    },
  });
  expect(response.status()).toBe(201);
}

interface RecordedSubmission {
  status: number;
  body: string;
  eventId: string | null;
}

interface RecordedPracticeStart {
  status: number;
  body: { sessionId?: string; item?: { answerRule?: unknown } } | null;
}

function recordPracticeStarts(page: Page): Array<Promise<RecordedPracticeStart>> {
  const recorded: Array<Promise<RecordedPracticeStart>> = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() !== "POST") return;
    if (!/^\/api\/practice\/[0-9a-f-]+$/i.test(new URL(response.url()).pathname)) return;
    recorded.push(
      (async () => ({
        status: response.status(),
        body: response.ok()
          ? ((await response.json()) as { sessionId?: string; item?: { answerRule?: unknown } })
          : null,
      }))(),
    );
  });
  return recorded;
}

function recordAttemptSubmissions(page: Page): Array<Promise<RecordedSubmission>> {
  const recorded: Array<Promise<RecordedSubmission>> = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() !== "POST") return;
    if (new URL(response.url()).pathname !== "/api/attempts") return;
    recorded.push(
      (async () => {
        const payload = response.ok()
          ? ((await response.json()) as { event?: { id?: string } })
          : null;
        return {
          status: response.status(),
          body: request.postData() ?? "",
          eventId: payload?.event?.id ?? null,
        };
      })(),
    );
  });
  return recorded;
}

async function finishAttempt(page: Page, options?: { revealAnswer?: boolean }) {
  if (options?.revealAnswer) {
    await page.getByRole("button", { name: "看答案" }).click();
    await expect(page.getByText("看过答案，本次不计入有效独立证据。")).toBeVisible();
  }
  await page.getByRole("button", { name: "检查答案" }).click();
  await page.getByRole("radio", { name: "4" }).click();
  await page.getByRole("button", { name: "提交这次作答" }).click();
  await expect(page).toHaveURL(/\/learn\/practice\/.+\/result/);
  await expect(page.getByRole("heading", { name: "作答结果" })).toBeVisible();
  await expect(page.getByText(/稳固|可用|薄弱|未测/)).toBeVisible();
}

test("replays the multiple-choice attempt request without creating a second event", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "practice-choice");
    const page = await context.newPage();
    const starts = recordPracticeStarts(page);
    const submissions = recordAttemptSubmissions(page);
    await page.goto(`/learn/practice/${choiceId}`);
    await expect(page.getByRole("heading", { name: "检验你的理解" })).toBeVisible();
    await page.getByRole("radio", { name: /教材定义表述/ }).check();
    await finishAttempt(page);

    const eventId = new URL(page.url()).searchParams.get("event");
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/i);

    const started = await Promise.all(starts);
    for (const start of started.filter((item) => item.status === 201)) {
      expect(start.body?.item?.answerRule).toBeUndefined();
      expect(start.body?.item).not.toHaveProperty("answerRule");
    }

    const recorded = await Promise.all(submissions);
    expect(recorded).toHaveLength(1);
    const first = recorded[0]!;
    expect(first.status).toBe(201);
    expect(first.eventId).toBe(eventId);

    const replayedBody = JSON.parse(first.body) as {
      idempotencyKey?: string;
      practiceSessionId?: string;
      correct?: unknown;
    };
    expect(replayedBody.idempotencyKey).toMatch(/.+/);
    expect(replayedBody.practiceSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(replayedBody).not.toHaveProperty("correct");

    const replay = await context.request.post("/api/attempts", { data: replayedBody });
    expect(replay.status()).toBe(201);
    const replayed = (await replay.json()) as { event: { id: string; idempotencyKey: string } };
    expect(replayed.event.id).toBe(eventId);
    expect(replayed.event.idempotencyKey).toBe(replayedBody.idempotencyKey);
  } finally {
    await context.close();
  }
});

test("captures a short-answer attempt and marks revealed answers as assisted", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "practice-short");
    const page = await context.newPage();
    await page.goto(`/learn/practice/${shortId}`);
    await page.getByLabel("你的答案").fill("定义");
    await finishAttempt(page, { revealAnswer: true });
  } finally {
    await context.close();
  }
});

test("captures a checkpoint attempt with multiple selected steps", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "practice-checkpoint");
    const page = await context.newPage();
    await page.goto(`/learn/practice/${checkpointId}`);
    await page.getByRole("checkbox", { name: /第一步：列式/ }).check();
    await page.getByRole("checkbox", { name: /第三步：规范求解/ }).check();
    await finishAttempt(page);
  } finally {
    await context.close();
  }
});
