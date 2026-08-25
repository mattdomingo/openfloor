/* Where the app is mounted. It now owns its own origin (app.opnflr.com),
   sibling to the marketing site rather than nested under it, so there is no
   prefix to add in any environment.

   Anything the framework rewrites (routes, <Link>, bundled assets) follows
   next.config's basePath on its own. This exists for the paths it does not
   rewrite: literal strings pointing at files in public/. Kept as a named
   constant, rather than inlined at each call site, so a future remount under
   a path prefix is a one-line change. */
export const BASE_PATH: string = "";
