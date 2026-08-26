import { describe, expect, it } from "vitest";
import { hashAccountEmail } from "@/lib/account-email-hash";

describe("hashAccountEmail", () => {
  it("is deterministic, and normalizes case/whitespace before hashing", async () => {
    const a = await hashAccountEmail("Person@Example.com", "secret-one");
    const b = await hashAccountEmail("  person@example.com  ", "secret-one");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keyed on the secret: different secrets produce unrecognizable hashes", async () => {
    const a = await hashAccountEmail("person@example.com", "secret-one");
    const b = await hashAccountEmail("person@example.com", "secret-two");
    expect(a).not.toBe(b);
  });

  it("different emails never collide", async () => {
    const a = await hashAccountEmail("person@example.com", "secret-one");
    const b = await hashAccountEmail("other@example.com", "secret-one");
    expect(a).not.toBe(b);
  });
});
