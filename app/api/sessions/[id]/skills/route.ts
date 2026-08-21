import { SessionEndedError } from "@/db/sessions";
import { listSessionSkillsForMember, SkillLimitError, upsertSessionSkill } from "@/db/skills";
import { readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseSkillContent } from "@/lib/skill-validation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const skills = await listSessionSkillsForMember((await params).id, user.id);
  if (!skills) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ skills });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const body = (await readJson(request)) as { content?: unknown } | null;
  const skill = parseSkillContent(body?.content);
  if (!skill) {
    return Response.json(
      { error: "A skill is a SKILL.md document: frontmatter with a lowercase slug name and a description, then instructions, at most 32,000 characters." },
      { status: 400 },
    );
  }
  try {
    const skills = await upsertSessionSkill((await params).id, user.id, skill);
    if (!skills) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ skills }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof SkillLimitError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
