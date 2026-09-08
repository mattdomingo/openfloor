import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("personal billing migration", () => {
  it("preserves an existing account, membership, agent, credential and prompt through additive upgrade", () => {
    const directory = new URL("../../drizzle/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(new URL(name, directory), "utf8"));
    const index = migrations.findIndex((sql) => sql.includes("ADD `usage_scope`"));
    expect(index).toBeGreaterThan(0);
    const database = new DatabaseSync(":memory:");
    try {
      for (const sql of migrations.slice(0, index)) database.exec(sql);
      database.exec(`INSERT INTO users (id, chatgpt_user_id, email, display_name, created_at, updated_at) VALUES ('person', 'identity', 'person@example.com', 'Person', 1, 1);
        INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('room', 'Room', 1, 1);
        INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES ('room', 'person', 'owner', 1);
        INSERT INTO floor_agents (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, created_at, updated_at) VALUES ('agent', 'room', 'person', 'person', 'Agent', 'agent', 'Engineer', 'Task', 'created', 1, 1);
        INSERT INTO user_provider_credentials (user_id, provider, kind, ciphertext, fingerprint, created_at, updated_at) VALUES ('person', 'anthropic', 'oauth', 'preserved-ciphertext', 'test', 1, 1);
        INSERT INTO floor_queue_items (id, session_id, position, status, created_at, updated_at) VALUES ('item', 'room', 1, 'queued', 1, 1);
        INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at) VALUES ('prompt', 'item', 'person', 'Keep the audit', 1);`);
      for (const sql of migrations.slice(index)) database.exec(sql);
      expect(database.prepare("SELECT default_api_provider FROM users WHERE id = 'person'").get()).toEqual({ default_api_provider: null });
      expect(database.prepare("SELECT auto_agents_enabled FROM session_members WHERE session_id = 'room'").get()).toEqual({ auto_agents_enabled: 1 });
      expect(database.prepare("SELECT usage_scope, owner_user_id FROM floor_agents WHERE id = 'agent'").get()).toEqual({ usage_scope: "private", owner_user_id: "person" });
      expect(database.prepare("SELECT ciphertext FROM user_provider_credentials").get()).toEqual({ ciphertext: "preserved-ciphertext" });
      expect(database.prepare("SELECT text FROM floor_queue_prompts").get()).toEqual({ text: "Keep the audit" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  });
});
