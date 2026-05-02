import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Preserve the existing static landing page at /
  // The Next.js root route is reserved for /bot and the api directory
  async rewrites() {
    return [
      {
        source: "/",
        destination: "/landing.html",
      },
    ];
  },
};

export default nextConfig;
