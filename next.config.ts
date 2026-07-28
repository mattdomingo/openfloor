import type { NextConfig } from "next";
import { BASE_PATH } from "./components/basePath";

const nextConfig: NextConfig = {
  // The marketing site owns opnflr.com; the product is mounted under /app by a
  // Workers route. basePath keeps every link, asset, and RSC request inside
  // that prefix, so the two deploys never contend for a path.
  //
  // Production only, because the dev server emits RSC stylesheet hrefs without
  // the prefix: it asks for /app/globals.css, which is the source path
  // app/globals.css and not basePath + globals.css, and every page renders
  // unstyled. The prefix colliding with the app/ directory is what makes those
  // two indistinguishable. A production build bundles CSS to /app/assets and
  // never takes that path.
  basePath: BASE_PATH,
};

export default nextConfig;
