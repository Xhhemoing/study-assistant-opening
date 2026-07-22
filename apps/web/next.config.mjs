/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@aistudy/domain",
    "@aistudy/contracts",
    "@aistudy/config",
    "@aistudy/ui",
    "@aistudy/database",
    "@aistudy/ai",
  ],
  output: "standalone",
};

export default nextConfig;
