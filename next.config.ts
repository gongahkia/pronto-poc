import type { NextConfig } from "next";
import { instagramRelayRewrites } from "./src/lib/channels/instagram-relay";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() { return { beforeFiles: instagramRelayRewrites(), afterFiles: [], fallback: [] }; },
  ...(process.env.PRONTO_LOW_MEMORY_BUILD === "1" ? { experimental: { webpackMemoryOptimizations: true, cpus: 1 } } : {}),
};

export default nextConfig;
