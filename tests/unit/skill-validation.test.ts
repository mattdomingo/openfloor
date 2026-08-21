import { describe, expect, it } from "vitest";
import { MAX_SKILL_CONTENT_CHARS, parseSkillContent } from "@/lib/skill-validation";

const VALID = `---
name: release-checklist
description: Use when preparing a release.
---

Check the changelog, then the version numbers.
`;

describe("skill content validation", () => {
  it("parses well-formed frontmatter and normalizes line endings", () => {
    const skill = parseSkillContent(VALID);
    expect(skill?.name).toBe("release-checklist");
    expect(skill?.description).toBe("Use when preparing a release.");
    expect(skill?.content.endsWith("\n")).toBe(true);
    expect(parseSkillContent(VALID.replace(/\n/g, "\r\n"))?.name).toBe("release-checklist");
  });

  it("tolerates extra frontmatter keys without acting on them", () => {
    const skill = parseSkillContent(VALID.replace("---\n\n", "allowed-tools: Bash(*)\n---\n\n"));
    expect(skill?.name).toBe("release-checklist");
  });

  it("rejects names that are not filesystem-safe slugs", () => {
    for (const name of ["../escape", "a/b", "a\\b", "UPPER", "with space", "", "-leading", "x".repeat(65)]) {
      expect(parseSkillContent(VALID.replace("release-checklist", name))).toBeNull();
    }
  });

  it("rejects missing or malformed frontmatter, empty bodies, and oversized content", () => {
    expect(parseSkillContent(null)).toBeNull();
    expect(parseSkillContent("no frontmatter at all")).toBeNull();
    expect(parseSkillContent("---\nname: a\n---\n\nBody")).toBeNull(); // no description
    expect(parseSkillContent("---\ndescription: d\n---\n\nBody")).toBeNull(); // no name
    expect(parseSkillContent("---\nname: a\ndescription: d\nnot-a-key-value\n---\n\nBody")).toBeNull();
    expect(parseSkillContent("---\nname: a\ndescription: d\n---\n\n")).toBeNull(); // empty body
    expect(parseSkillContent(`${VALID}${"x".repeat(MAX_SKILL_CONTENT_CHARS)}`)).toBeNull();
    expect(parseSkillContent(VALID.replace("Use when preparing a release.", "x".repeat(501)))).toBeNull();
  });
});
