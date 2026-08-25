import type { NextConfig } from "next";
import { BASE_PATH } from "./components/basePath";

const nextConfig: NextConfig = {
  // The app is mounted at the root of its own origin (app.opnflr.com), so
  // BASE_PATH is empty. Kept wired through rather than deleted, so remounting
  // under a path prefix again is a one-line change in components/basePath.ts.
  basePath: BASE_PATH,
};

export default nextConfig;
