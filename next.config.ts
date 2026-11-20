import type { NextConfig } from "next";
import { instagramRelayRewrites } from "./src/lib/channels/instagram-relay";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() { return { beforeFiles: instagramRelayRewrites(), afterFiles: [], fallback: [] }; },
  experimental: {
    // a 25 MB source plus multipart headers must reach the route intact
    proxyClientMaxBodySize: 26 * 1024 * 1024,
    ...(process.env.PRONTO_LOW_MEMORY_BUILD === "1" ? {webpackMemoryOptimizations:true,cpus:1} : {}),
  },
};

export default nextConfig;
