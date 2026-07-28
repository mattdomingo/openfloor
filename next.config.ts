import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The marketing site owns opnflr.com; the product is mounted under /app by a
  // Workers route. basePath keeps every link, asset, and RSC request inside
  // that prefix, so the two deploys never contend for a path.
  basePath: "/app",
};

export default nextConfig;
