import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptInvite, createSession, endSession, SessionEndedError, upsertUser } from "@/db/sessions";
import {
  deleteSessionSkill,
  getSessionSkillsForRun,
  listSessionSkillsForMember,
  SkillLimitError,
  upsertSessionSkill,
} from "@/db/skills";
import { MAX_SKILLS_PER_SESSION, parseSkillContent } from "@/lib/skill-validation";

function identity(id: string, name: string) {
  return { providerUserId: `skills-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

function skill(name: string, description = "Use when testing.") {
  const parsed = parseSkillContent(`---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`);
  if (!parsed) throw new Error("Invalid test skill");
  return parsed;
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`, "Outsider Example"), env.DB);
  const created = await createSession(owner.id, { title: `Skills ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member, outsider };
}

describe("session skills persistence", () => {
  it("owner imports and replaces by name; members read; outsiders are concealed", async () => {
    const { sessionId, owner, member, outsider } = await room("crud");
    const afterAdd = await upsertSessionSkill(sessionId, owner.id, skill("release-checklist"), env.DB);
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd?.[0]).toEqual(expect.objectContaining({ name: "release-checklist", description: "Use when testing." }));
    // Summaries never include content.
    expect(afterAdd?.[0]).not.toHaveProperty("content");

    const replaced = await upsertSessionSkill(sessionId, owner.id, skill("release-checklist", "Updated description."), env.DB);
    expect(replaced).toHaveLength(1);
    expect(replaced?.[0].description).toBe("Updated description.");

    expect(await listSessionSkillsForMember(sessionId, member.id, env.DB)).toHaveLength(1);
    expect(await listSessionSkillsForMember(sessionId, outsider.id, env.DB)).toBeNull();
    // Members cannot mutate.
    expect(await upsertSessionSkill(sessionId, member.id, skill("member-skill"), env.DB)).toBeNull();
    expect(await deleteSessionSkill(sessionId, member.id, replaced![0].id, env.DB)).toBeNull();

    const contents = await getSessionSkillsForRun(sessionId, env.DB);
    expect(contents).toHaveLength(1);
    expect(contents[0].content).toContain("Do the thing.");

    const afterDelete = await deleteSessionSkill(sessionId, owner.id, replaced![0].id, env.DB);
    expect(afterDelete).toHaveLength(0);
  });

  it("enforces the per-session count cap for new names but allows replacement at the cap", async () => {
    const { sessionId, owner } = await room("cap");
    for (let index = 0; index < MAX_SKILLS_PER_SESSION; index += 1) {
      await upsertSessionSkill(sessionId, owner.id, skill(`skill-${index}`), env.DB);
    }
    await expect(upsertSessionSkill(sessionId, owner.id, skill("one-too-many"), env.DB)).rejects.toBeInstanceOf(SkillLimitError);
    const replaced = await upsertSessionSkill(sessionId, owner.id, skill("skill-0", "Still replaceable."), env.DB);
    expect(replaced?.find((entry) => entry.name === "skill-0")?.description).toBe("Still replaceable.");
  });

  it("refuses mutations on an ended session but keeps reads working", async () => {
    const { sessionId, owner, member } = await room("ended");
    await upsertSessionSkill(sessionId, owner.id, skill("kept"), env.DB);
    await endSession(sessionId, owner.id, "owner", env.DB);
    await expect(upsertSessionSkill(sessionId, owner.id, skill("late"), env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    expect(await listSessionSkillsForMember(sessionId, member.id, env.DB)).toHaveLength(1);
  });
});
