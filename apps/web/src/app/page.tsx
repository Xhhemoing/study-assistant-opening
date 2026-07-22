import { PLATFORM_NAME } from "@aistudy/domain";

export default function HomePage() {
  return (
    <main style={{ padding: "2rem", maxWidth: 720 }}>
      <h1>{PLATFORM_NAME}</h1>
      <p>终身学习平台脚手架已就绪。</p>
      <p>
        健康检查：{" "}
        <a href="/api/health" style={{ color: "#6ea8fe" }}>
          /api/health
        </a>
      </p>
    </main>
  );
}
