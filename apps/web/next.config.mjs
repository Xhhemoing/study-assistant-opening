/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@aistudy/domain",
    "@aistudy/contracts",
    "@aistudy/ui",
    "@aistudy/config",
  ],
  output: "standalone",
};

export default nextConfig;
