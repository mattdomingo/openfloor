import type { SessionPresence } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      INVITE_SIGNING_SECRET: string;
      GITHUB_APP_ID: string;
      GITHUB_APP_SLUG: string;
      GITHUB_APP_PRIVATE_KEY: string;
      GITHUB_STATE_SECRET: string;
      GITHUB_WEBHOOK_SECRET: string;
      SESSION_PRESENCE: DurableObjectNamespace<SessionPresence>;
      TEST_MIGRATIONS: string;
    }
  }
}

export {};
