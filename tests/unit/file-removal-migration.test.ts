import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("stacked file removal migration", () => {
  it("preserves predecessor records and supports fresh databases without table recreation", () => {
    const directory = new URL("../../drizzle/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(new URL(name, directory), "utf8"));
    const index = migrations.findIndex((sql) => sql.includes("CREATE TABLE `candidate_file_removals`"));
    expect(index).toBeGreaterThan(0);
    expect(migrations[index]).not.toMatch(/DROP TABLE|__new_/i);
    for (const upgrade of [false, true]) {
      const database = new DatabaseSync(":memory:");
      try {
        for (const sql of migrations.slice(0, index)) database.exec(sql);
        if (upgrade) database.exec(`
          INSERT INTO users (id, chatgpt_user_id, email, display_name, default_api_provider, verified_github, created_at, updated_at)
            VALUES ('person', 'identity', 'person@example.com', 'Person', 'openai', '{"id":"123","login":"engineer","verifiedAt":1}', 1, 1);
          INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('room', 'Room', 1, 1);
          INSERT INTO session_members (session_id, user_id, role, joined_at, auto_agents_enabled) VALUES ('room', 'person', 'owner', 1, 0);
          INSERT INTO floor_agents (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, usage_scope, created_at, updated_at)
            VALUES ('agent', 'room', 'person', 'person', 'Agent', 'agent', 'Engineer', 'Task', 'created', 'session', 1, 1);
          INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
            VALUES ('repo', 'room', '123', '456', 'R_456', 'team', 'project', 'team/project', 1, 'main', 'main', 'ready', 'person', 1, 1);
          INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
            VALUES ('candidate', 'room', 'repo', 'openfloor/candidate', 'main', 'base-sha', 'active', 'person', 1, 1);
          INSERT INTO repository_candidate_files (id, candidate_id, path, additions, deletions, change_kind, patch_preview)
            VALUES ('file', 'candidate', 'src/keep.ts', 1, 0, 'add', '+keep');
        `);
        for (const sql of migrations.slice(index)) database.exec(sql);
        if (upgrade) {
          expect(database.prepare("SELECT default_api_provider, verified_github FROM users").get()).toEqual({ default_api_provider: "openai", verified_github: '{"id":"123","login":"engineer","verifiedAt":1}' });
          expect(database.prepare("SELECT path, patch_preview, previous_path FROM repository_candidate_files").get()).toEqual({ path: "src/keep.ts", patch_preview: "+keep", previous_path: null });
          expect(database.prepare("SELECT auto_agents_enabled FROM session_members").get()).toEqual({ auto_agents_enabled: 0 });
          expect(database.prepare("SELECT usage_scope, owner_user_id FROM floor_agents").get()).toEqual({ usage_scope: "session", owner_user_id: "person" });
        }
        expect(database.prepare("SELECT COUNT(*) AS count FROM candidate_file_removals").get()).toEqual({ count: 0 });
        expect(database.prepare("PRAGMA table_info(repository_candidate_files)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "previous_path", notnull: 0 })]));
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { database.close(); }
    }
  });
});
