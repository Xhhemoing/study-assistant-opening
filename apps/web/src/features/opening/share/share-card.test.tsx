// @vitest-environment jsdom
import { resolve } from "node:path";
import { getShareablePitfallById } from "@aistudy/domain";
import { resolveImages } from "next/dist/lib/metadata/resolvers/resolve-opengraph";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

const navMocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  ogCalls: [] as Array<{
    element: unknown;
    options: { width?: number; height?: number; headers?: Record<string, string> } | undefined;
  }>,
}));

vi.mock("next/navigation", () => ({
  notFound: navMocks.notFound,
  usePathname: () => "/s/test",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/og", () => ({
  ImageResponse: class MockImageResponse extends Response {
    constructor(
      element: unknown,
      options?: { width?: number; height?: number; headers?: Record<string, string> },
    ) {
      navMocks.ogCalls.push({ element, options });
      super(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png", ...(options?.headers ?? {}) },
      });
    }
  },
}));

import SharePitfallNotFound from "../../../app/s/[token]/not-found";
import OpenGraphImage, { dynamic as ogDynamic } from "../../../app/s/[token]/opengraph-image";
import SharePitfallPage, { generateMetadata } from "../../../app/s/[token]/page";
import { InvalidShareCard, PitfallShareCard } from "./share-card";
import { mintPitfallShareTokenById, signPitfallShareToken } from "./token-codec";

const TEST_SECRET = "share-ui-test-secret-0123456789abcdef0123";
const sampleCard = {
  subjectLabel: "数据结构",
  pitfallTitle: "BFS 入队时就该标记已访问",
  trapSummary: "等出队才标记，同一节点会被重复压入队列。",
  takeawayRule: "BFS 标访问一定在入队那一刻完成。",
  cohortSampleSize: 36,
  cohortTrapRate: 52,
};

describe("PitfallShareCard, /s/[token] page, and opengraph-image", () => {
  const originalSecret = process.env.AUTH_SECRET;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    process.env.AUTH_SECRET = TEST_SECRET;
    navMocks.notFound.mockClear();
    navMocks.ogCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalSecret;
    }
  });

  it.each([true, false])("renders the share card and downloads its SVG with public try enabled=%s", async (enabled) => {
    vi.stubEnv("OPENING_PUBLIC_TRY", enabled ? "1" : "0");
    const createObjectURL = vi.fn(() => "blob:mock-poster-url");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const signed = signPitfallShareToken(
      {
        subjectLabel: "概率论",
        pitfallTitle: "条件概率分母别代错",
        trapSummary: "把 P(A|B) 的分母当成 P(A) 来算，结果直接算反。",
        takeawayRule: "竖线后面是谁，分母就是谁。",
        cohortSampleSize: 55,
        cohortTrapRate: 71,
      },
      { authSecret: TEST_SECRET },
    );

    const element = await SharePitfallPage({
      params: Promise.resolve({ token: signed.token }),
    });
    await act(async () => {
      root.render(element);
    });

    expect(host.textContent).toContain("防踩坑避雷卡");
    expect(host.textContent).toContain("概率论");
    expect(host.textContent).toContain("条件概率分母别代错");
    expect(host.textContent).toContain("约 71% 同学曾在此踩坑 · 55 人样本");

    const cta = host.querySelector(enabled ? 'a[href="/try"]' : 'a[href="/login"]');
    expect(cta?.textContent).toContain(enabled ? "90 秒亲自排雷挑战" : "登录后开启完整诊断");

    const downloadButton = Array.from(host.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("保存 SVG 海报"),
    );
    expect(downloadButton).toBeTruthy();

    await act(async () => {
      downloadButton!.click();
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blobArg = (createObjectURL.mock.calls[0] as unknown[] | undefined)?.[0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect((blobArg as Blob).type).toBe("image/svg+xml;charset=utf-8");
    const svg = await act(() => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blobArg as Blob);
    }));
    if (enabled) {
      expect(svg).toContain("/try");
      expect(svg).toContain("90 秒亲自排雷挑战");
    } else {
      expect(svg).not.toMatch(/\/try|90 秒亲自排雷挑战/);
      expect(svg).toContain("复习时再看一遍避坑口诀");
    }
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("已生成 SVG 海报");
  });

  it("renders the complete TCP recovery rule from a catalog-minted share token", async () => {
    const pitfallId = "408-cn-tcp-congestion-ssthresh";
    const entry = getShareablePitfallById(pitfallId);
    assert.isNotNull(entry);
    const { token } = mintPitfallShareTokenById({ pitfallId });
    const page = await SharePitfallPage({ params: Promise.resolve({ token }) });
    await act(async () => root.render(page));

    expect(host.textContent).toContain(entry.trapSummary);
    expect(host.textContent).toContain(entry.takeawayRule);
  });

  it("hides cohort badge when cohortSampleSize < 30 even if rate is passed directly", async () => {
    await act(async () => {
      root.render(
        <PitfallShareCard
          card={{
            subjectLabel: "微积分",
            pitfallTitle: "换元积分别忘换上下限",
            trapSummary: "变量已经换成 u，上下限还留着 x 的值。",
            takeawayRule: "定积分换元三步走：换元、换微分、换上下限。",
            cohortSampleSize: 12,
            cohortTrapRate: 85,
          }}
        />,
      );
    });

    expect(host.querySelector('[data-testid="cohort-trap-badge"]')).toBeNull();
    expect(host.textContent).not.toContain("85%");
    expect(host.textContent).not.toContain("人样本");
  });

  it("triggers notFound() for invalid or expired tokens and renders calm Chinese fallback without internals", async () => {
    await expect(
      SharePitfallPage({ params: Promise.resolve({ token: "tampered.invalid" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(navMocks.notFound).toHaveBeenCalledOnce();

    const expired = signPitfallShareToken(
      {
        subjectLabel: "微积分",
        pitfallTitle: "定积分奇偶性先看区间是否对称",
        trapSummary: "区间不对称就直接套偶倍奇零。",
        takeawayRule: "先看 [-a, a] 对称，再判奇偶。",
        cohortSampleSize: 0,
        cohortTrapRate: null,
        ttlSeconds: 60,
      },
      { authSecret: TEST_SECRET, nowMs: Date.now() - 120_000 },
    );

    await expect(
      SharePitfallPage({ params: Promise.resolve({ token: expired.token }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    const badMeta = await generateMetadata({
      params: Promise.resolve({ token: "tampered.invalid" }),
    });
    expect(badMeta.title).toBe("防踩坑避雷卡 | AIstudy");
    expect(JSON.stringify(badMeta)).not.toMatch(/signature|hmac|secret/i);

    await act(async () => {
      root.render(<SharePitfallNotFound />);
    });
    expect(host.textContent).toContain("这张避雷卡已失效或链接不完整");
    expect(host.textContent).not.toMatch(/signature|hmac|token|secret/i);
    expect(host.querySelector('a[href="/try"]')?.textContent).toContain("90 秒亲自排雷挑战");

    await act(async () => {
      root.render(<InvalidShareCard />);
    });
    expect(host.textContent).toContain("这张避雷卡已失效或链接不完整");
  });

  it("uses the configured self-hosted origin for the share page metadata", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("PUBLIC_BASE_URL", "https://study.example:8443/");
    const { token } = signPitfallShareToken(sampleCard);
    const metadata = await generateMetadata({ params: Promise.resolve({ token }) });
    expect(metadata.metadataBase?.href).toBe("https://study.example:8443/");
    expect(metadata.openGraph).toMatchObject({
      title: `${sampleCard.pitfallTitle} · 防踩坑避雷卡`,
      description: sampleCard.trapSummary,
      type: "article",
    });
    const imagePath = `/s/${token}/opengraph-image`;
    const images = resolveImages(imagePath, metadata.metadataBase ?? null, true);
    expect(images).toMatchObject([{ url: { href: `https://study.example:8443${imagePath}` } }]);
  });

  it.each([undefined, "invalid-url", "file:///tmp"])("handles an unavailable public origin (%s)", async (origin) => {
    vi.stubEnv("PUBLIC_BASE_URL", origin);
    const { token } = signPitfallShareToken(sampleCard);
    const metadata = await generateMetadata({ params: Promise.resolve({ token }) });
    expect(metadata.metadataBase).toBeNull();
    expect(metadata.openGraph?.description).toBe(sampleCard.trapSummary);
  });

  it("returns the same non-cacheable plaintext 404 for malformed, expired and mis-signed OG requests", async () => {
    const expired = signPitfallShareToken({ ...sampleCard, ttlSeconds: 60 }, { nowMs: Date.now() - 120_000 });
    const misSigned = signPitfallShareToken(sampleCard, { authSecret: `${TEST_SECRET}-other` });
    for (const token of ["malformed", expired.token, misSigned.token]) {
      const response = await OpenGraphImage({ params: Promise.resolve({ token }) });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("Not Found");
    }
    expect(navMocks.ogCalls).toHaveLength(0);
  });

  it("generates non-cacheable OpenGraph images with the appropriate badge and footer", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(resolve(__dirname, "../../../.."));
    expect(ogDynamic).toBe("force-dynamic");
    vi.stubEnv("OPENING_PUBLIC_TRY", "1");
    const signed = signPitfallShareToken(sampleCard);

    const validOg = await OpenGraphImage({
      params: Promise.resolve({ token: signed.token }),
    });
    expect(validOg).toBeInstanceOf(Response);
    expect(validOg.status).toBe(200);
    expect(validOg.headers.get("cache-control")).toBe("no-store");
    expect(navMocks.ogCalls[0]?.options).toMatchObject({
      width: 1200,
      height: 630,
      headers: { "Cache-Control": "no-store" },
    });
    expect(JSON.stringify(navMocks.ogCalls[0]?.element)).toContain("BFS 入队时就该标记已访问");
    expect(JSON.stringify(navMocks.ogCalls[0]?.element)).toContain("约 52% 同学曾在此踩坑 · 36 人样本");
    expect(JSON.stringify(navMocks.ogCalls[0]?.element)).toContain("90 秒亲自排雷挑战 · /try");

    const smallCohort = signPitfallShareToken(
      {
        subjectLabel: "数据结构",
        pitfallTitle: "DFS 回溯别忘撤销现场",
        trapSummary: "递归返回后未恢复状态数组。",
        takeawayRule: "进入前做标记，返回后立即撤销。",
        cohortSampleSize: 10,
        cohortTrapRate: 90,
      },
      { authSecret: TEST_SECRET },
    );
    vi.stubEnv("OPENING_PUBLIC_TRY", "0");
    await OpenGraphImage({ params: Promise.resolve({ token: smallCohort.token }) });
    expect(JSON.stringify(navMocks.ogCalls[1]?.element)).not.toContain("90%");
    expect(JSON.stringify(navMocks.ogCalls[1]?.element)).not.toContain("人样本");

    expect(JSON.stringify(navMocks.ogCalls[1]?.element)).not.toMatch(/\/try|90 秒亲自排雷挑战/);
    expect(JSON.stringify(navMocks.ogCalls[1]?.element)).toContain("复习时再看一遍避坑口诀");
  });

  it("routes share card CTAs to /login when tryAvailable is false or OPENING_PUBLIC_TRY=0", async () => {
    await act(async () => {
      root.render(
        <PitfallShareCard
          card={{
            subjectLabel: "高等数学",
            pitfallTitle: "洛必达法则别忘先验型",
            trapSummary: "非 0/0 或 ∞/∞ 型直接求导会导致错误结论。",
            takeawayRule: "先代入判型，再决定是否使用洛必达。",
            cohortSampleSize: 0,
            cohortTrapRate: null,
          }}
          tryAvailable={false}
        />,
      );
    });

    expect(host.querySelector('a[href="/try"]')).toBeNull();
    const directLoginCta = host.querySelector('a[href="/login"]');
    expect(directLoginCta?.textContent).toContain("登录后开启完整诊断");

    vi.stubEnv("OPENING_PUBLIC_TRY", "0");

    const signed = signPitfallShareToken(
      {
        subjectLabel: "数据结构",
        pitfallTitle: "BFS 入队时就该标记已访问",
        trapSummary: "等出队才标记，同一节点会被重复压入队列。",
        takeawayRule: "BFS 标访问一定在入队那一刻完成。",
        cohortSampleSize: 0,
        cohortTrapRate: null,
      },
      { authSecret: TEST_SECRET },
    );

    const pageElement = await SharePitfallPage({
      params: Promise.resolve({ token: signed.token }),
    });
    await act(async () => {
      root.render(pageElement);
    });
    expect(host.querySelector('a[href="/try"]')).toBeNull();
    expect(host.querySelector('a[href="/login"]')?.textContent).toContain("登录后开启完整诊断");

    await act(async () => {
      root.render(<SharePitfallNotFound />);
    });
    expect(host.querySelector('a[href="/try"]')).toBeNull();
    expect(host.querySelector('a[href="/login"]')?.textContent).toContain("登录后开启完整诊断");
  });
});
