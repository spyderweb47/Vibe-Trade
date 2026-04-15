import type { NextConfig } from "next";

/**
 * Config supports TWO modes:
 *
 *   1. Dev / `npm run dev` — standard Next.js dev server on port 3001.
 *   2. Static export — `npm run export` (sets EXPORT=1) produces a
 *      pre-rendered site in `out/` that the Python CLI bundles and serves
 *      from `vibe-trade serve` without needing Node.js at runtime.
 *
 * All pages in this app are client-side (no server actions, no API routes),
 * so static export works cleanly.
 */
const isExport = process.env.EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isExport
    ? {
        output: "export",
        // Static export needs a trailing slash so nested routes resolve
        // when served from a filesystem / Python StaticFiles mount.
        trailingSlash: true,
        // Disable image optimization for static exports
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
