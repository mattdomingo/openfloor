/* Where the app is mounted. Production serves it under opnflr.com/app, next to
   the marketing site; the dev server serves it at the root, because a basePath
   breaks stylesheet resolution there (see next.config.ts).

   Anything the framework rewrites (routes, <Link>, bundled assets) follows
   next.config's basePath on its own. This exists for the paths it does not
   rewrite: literal strings pointing at files in public/. NODE_ENV is inlined by
   the bundler in every environment, so this resolves at build time. */
export const BASE_PATH = process.env.NODE_ENV === "production" ? "/app" : "";
