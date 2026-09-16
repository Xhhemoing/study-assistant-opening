import { expect, test } from "@playwright/test";

function user(label: string) {
  return {
    email: `${label}-${Date.now()}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("selectively promotes one exploration candidate without duplicating its note", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  try {
    expect(
      (
        await context.request.post("/api/auth/register", {
          headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
          data: user("promotion"),
        })
      ).status(),
    ).toBe(201);
    const exploration = await context.request.post("/api/explorations", {
      headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: { title: "Promotion source" },
    });
    const explorationId = (await exploration.json()).exploration.id as string;
    const create = (title: string) =>
      context.request.post(`/api/explorations/${explorationId}/promotions`, {
        headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: { kind: "note", title, body: `${title} body` },
      });
    const first = (await (await create("Keep")).json()).promotion;
    const second = (await (await create("Reject")).json()).promotion;
    const accepted = (
      await (
        await context.request.post(`/api/promotions/${first.id}/accept`, { headers: { origin: baseURL ?? "http://127.0.0.1:3000" } })
      ).json()
    ).promotion;
    expect(accepted.targetType).toBe("document");
    const document = await context.request.get(
      `/api/documents/${accepted.targetId}`,
    );
    const current = (await document.json()).document;
    const edited = await context.request.patch(
      `/api/documents/${accepted.targetId}`,
      {
        data: {
          title: "Edited",
          expectedRevisionNumber: current.currentRevisionNumber,
          blocks: current.blocks.map((block: { id: string; type: string }) => ({
            ...block,
            content: { text: "Edited body" },
          })),
        },
      },
    );
    expect(edited.status()).toBe(200);
    const createCourse = async (title: string, slug: string) => {
      const response = await context.request.post("/api/courses", {
        headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: { title, slug },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).course.id as string;
    };
    const courseA = await createCourse(
      "Promotion A",
      `promotion-a-${Date.now()}`,
    );
    const courseB = await createCourse(
      "Promotion B",
      `promotion-b-${Date.now()}`,
    );
    const membership = {
      assetType: "document",
      assetId: accepted.targetId,
      role: "core",
      visibility: "course",
    };
    expect(
      (
        await context.request.post(`/api/courses/${courseA}/memberships`, {
          headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
          data: membership,
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await context.request.post(`/api/courses/${courseB}/memberships`, {
          headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
          data: membership,
        })
      ).status(),
    ).toBe(201);
    const assetsA = (
      await (await context.request.get(`/api/courses/${courseA}/assets`)).json()
    ).assets;
    const assetsB = (
      await (await context.request.get(`/api/courses/${courseB}/assets`)).json()
    ).assets;
    expect(assetsA).toHaveLength(1);
    expect(assetsB).toHaveLength(1);
    expect(assetsA[0].document.id).toBe(accepted.targetId);
    expect(assetsB[0].document.id).toBe(accepted.targetId);
    const provenance = await context.request.get(
      `/api/documents/${accepted.targetId}/promotion-source`,
    );
    expect(provenance.status()).toBe(200);
    expect((await provenance.json()).promotion.explorationId).toBe(
      explorationId,
    );
    const page = await context.newPage();
    await page.goto(`/library/${accepted.targetId}`);
    const sourceLink = page.getByRole("link", { name: "返回来源探索" });
    await expect(sourceLink).toHaveAttribute(
      "href",
      `/explore/${explorationId}`,
    );
    await sourceLink.click();
    await expect(page).toHaveURL(new RegExp(`/explore/${explorationId}$`));
    const rejected = await context.request.post(
      `/api/promotions/${second.id}/reject`,
    );
    expect((await rejected.json()).promotion.status).toBe("rejected");
    const outcomes = await context.request.get(
      `/api/explorations/${explorationId}/promotions`,
    );
    expect(
      (await outcomes.json()).promotions.map(
        (item: { status: string }) => item.status,
      ),
    ).toEqual(["accepted", "rejected"]);
  } finally {
    await context.close();
  }
});
