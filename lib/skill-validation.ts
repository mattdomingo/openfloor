// Validation for owner-imported Claude skills. Skills are user-supplied
// content that becomes agent instructions, so everything is bounded and the
// name is constrained to a filesystem-safe slug — the materialization path
// joins it into ~/.claude/skills/<name>/SKILL.md, and this regex is what
// makes path separators and traversal segments unrepresentable. Pure module;
// unit-tested directly.

export const MAX_SKILL_CONTENT_CHARS = 32_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 500;
export const MAX_SKILLS_PER_SESSION = 20;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ParsedSkill = { name: string; description: string; content: string };

// Requires well-formed frontmatter with `name` and `description`. Other
// frontmatter keys are tolerated but have no effect — in particular a
// skill's `allowed-tools` cannot widen the run's toolset (the runner sets
// tools/allowedTools explicitly, and that field is inert for filesystem
// skills in SDK sessions; keep it that way).
export function parseSkillContent(value: unknown): ParsedSkill | null {
  if (typeof value !== "string") return null;
  const content = value.replace(/\r\n/g, "\n").trim();
  if (!content || content.length > MAX_SKILL_CONTENT_CHARS) return null;
  if (!content.startsWith("---\n")) return null;
  const closing = content.indexOf("\n---", 4);
  if (closing < 0) return null;
  const frontmatter = content.slice(4, closing);
  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim();
    const fieldValue = line.slice(separator + 1).trim();
    if (!fields.has(key)) fields.set(key, fieldValue);
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!SKILL_NAME_PATTERN.test(name)) return null;
  if (!description || description.length > MAX_SKILL_DESCRIPTION_CHARS) return null;
  const body = content.slice(closing + 4).trim();
  if (!body) return null;
  return { name, description, content: `${content}\n` };
}
