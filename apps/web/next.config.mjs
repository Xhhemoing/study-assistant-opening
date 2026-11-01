import { computeBuildConfigDigest } from "../../packages/config/src/public/build-config.mjs";

// PR-H: NEXT_PUBLIC_* is inlined at build, so a runtime env check cannot prove what
// the bundle contains. No public build-time switch is allowed; the browser reads
// /api/opening/capabilities. The digest records the (empty) public build surface.
const buildTimePublic = Object.keys(process.env).filter((name) => name.startsWith("NEXT_PUBLIC_"));
if (buildTimePublic.length) {
  throw new Error(`NEXT_PUBLIC_* is not allowed at build (inlined into the browser bundle): ${buildTimePublic.join(", ")}`);
}
const buildConfigDigest = computeBuildConfigDigest(process.env);

/** @type {import('next').NextConfig} */
const useOpeningE2e = process.env.OPENING_E2E === "1";
const useLocalPreview = !useOpeningE2e && process.env.AISTUDY_WEB_PREVIEW === "1";
// The managed release builds an exact SHA whose push CI already passed lint and
// typecheck. Repeating Next's in-build type check on the small release host exceeds
// its memory, so only that runner opts out; CI and local builds keep both checks.
const skipVerifiedChecks = process.env.AISTUDY_RELEASE_VERIFIED_SHA === "1";
const nextConfig = {
  ...(skipVerifiedChecks ? { typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } } : {}),
  // Keep loopback redirects on the request host so host-only auth cookies survive.
  skipMiddlewareUrlNormalize: true,
  // Staging PUTs carry raw PDF bytes (product limit: 50 MiB). Next's default
  // 10 MiB middleware clone silently truncates them before stream validation.
  // This is a transport ceiling, not admission: tickets/ownership and streaming
  // byte/hash/MIME checks still enforce the per-upload product limits.
  experimental: { middlewareClientMaxBodySize: "50mb" },
  env: {
    AISTUDY_BUILD_CONFIG_DIGEST: buildConfigDigest,
    AISTUDY_COMMIT: process.env.AISTUDY_COMMIT ?? "",
    AISTUDY_BUILT_AT: new Date().toISOString(),
  },
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
    "@aistudy/jingwei",
    "@aistudy/senseweave",
  ],
  output: useOpeningE2e || useLocalPreview ? undefined : "standalone",
  outputFileTracingIncludes: {
    "/api/opening/pdfjs-assets/**": ["../../node_modules/pdfjs-dist/{package.json,LICENSE,cmaps/**,standard_fonts/**,wasm/**,iccs/**}"],
  },
};

export default nextConfig;
