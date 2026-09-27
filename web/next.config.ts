import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // @electric-sql/pglite ships a binary asset (dist/pglite.data) that it loads
  // relative to its own package directory at runtime. Turbopack/webpack tracing
  // that dynamic `require()` (see src/db/index.ts's dev-only PGlite branch)
  // rewrites that relative lookup and breaks it (ENOENT on a synthetic /ROOT/...
  // path). Marking the package external keeps it a plain Node `require` from
  // node_modules at runtime instead, which resolves the asset correctly.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  // Plan became Calendar (2026-09-27): old links, with their ?day=, still land.
  // The AI slop tab went the same day: its check is Write's, on paste.
  async redirects() {
    return [
      { source: "/plan", destination: "/calendar", permanent: true },
      { source: "/ai-slop", destination: "/create", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
