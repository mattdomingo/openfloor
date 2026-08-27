import type { SessionPresence } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      CF_ACCESS_TEAM_DOMAIN?: string;
      INVITE_SIGNING_SECRET: string;
      GITHUB_APP_ID: string;
      GITHUB_APP_CLIENT_ID?: string;
      GITHUB_APP_SLUG: string;
      GITHUB_APP_PRIVATE_KEY: string;
      GITHUB_STATE_SECRET: string;
      GITHUB_WEBHOOK_SECRET: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET: string;
      STRIPE_PRO_PRICE_ID: string;
      STRIPE_MAX_PRICE_ID: string;
      STRIPE_PORTAL_CONFIGURATION_ID: string;
      STRIPE_CHECKOUT_ENABLED: string;
      SESSION_PRESENCE: DurableObjectNamespace<SessionPresence>;
      TEST_MIGRATIONS: string;
      ACCOUNT_EMAIL_MERGE_QUERIES: string;
      AUTO_AGENT_DATA_MIGRATION_QUERIES: string;
      ACCOUNT_GITHUB_MIGRATION_QUERIES: string;
    }
  }
}

export {};
