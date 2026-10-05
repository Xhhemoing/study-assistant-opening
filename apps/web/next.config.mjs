/** @type {import('next').NextConfig} */
const useOpeningE2e = process.env.OPENING_E2E === "1";
const useLocalPreview = !useOpeningE2e && process.env.AISTUDY_WEB_PREVIEW === "1";
const nextConfig = {
  // Keep loopback redirects on the request host so host-only auth cookies survive.
  skipMiddlewareUrlNormalize: true,
  ...(useOpeningE2e ? {
    distDir: ".next-opening-e2e",
    typescript: { tsconfigPath: "tsconfig.opening-e2e.json" },
  } : useLocalPreview ? {
    distDir: ".next-preview",
    typescript: { tsconfigPath: "tsconfig.preview.json" },
  } : {}),
  transpilePackages: [
    "@aistudy/domain",
    "@aistudy/contracts",
    "@aistudy/config",
    "@aistudy/ui",
    "@aistudy/database",
    "@aistudy/ai",
  ],
  output: useOpeningE2e || useLocalPreview ? undefined : "standalone",
};

export default nextConfig;
