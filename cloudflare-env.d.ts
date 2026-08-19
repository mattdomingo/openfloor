import type { SessionPresence } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      INVITE_SIGNING_SECRET: string;
      SESSION_PRESENCE: DurableObjectNamespace<SessionPresence>;
      TEST_MIGRATIONS: string;
    }
  }
}

export {};
