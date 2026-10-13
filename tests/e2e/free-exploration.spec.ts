import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return { email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, password: "password123", displayName: label };
}

test("does not expose another user's exploration", async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  try {
    const owner = await ownerContext.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("exploration-owner") });
    const other = await otherContext.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("exploration-other") });
    expect(owner.status()).toBe(201);
    expect(other.status()).toBe(201);
    const created = await ownerContext.request.post("/api/explorations", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: { title: "Private exploration" } });
    const id = (await created.json()).exploration.id as string;
    const denied = await otherContext.request.get(`/api/explorations/${id}`);
    expect(denied.status()).toBe(403);
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});
