/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep loopback redirects on the request host so host-only auth cookies survive.
  skipMiddlewareUrlNormalize: true,
  transpilePackages: [
    "@aistudy/domain",
    "@aistudy/contracts",
    "@aistudy/config",
    "@aistudy/ui",
    "@aistudy/database",
    "@aistudy/ai",
  ],
  output: process.env.OPENING_E2E === "1" ? undefined : "standalone",
  ...(process.env.OPENING_E2E === "1" ? {
    distDir: ".next-opening-e2e",
    typescript: { tsconfigPath: "tsconfig.opening-e2e.json" },
  } : {}),
};

export default nextConfig;
