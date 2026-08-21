import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "@/lib/credential-crypto";

const SECRET = "unit-test-credential-encryption-secret";
const CONTEXT = "user-1:anthropic";

describe("credential crypto", () => {
  it("round-trips a credential under the same secret and context", async () => {
    const payload = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    expect(payload).not.toContain("sk-ant-example-1234");
    expect(await decryptCredential(payload, SECRET, CONTEXT)).toBe("sk-ant-example-1234");
  });

  it("produces a fresh ciphertext per encryption", async () => {
    const first = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    const second = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    expect(first).not.toBe(second);
  });

  it("fails closed on the wrong secret", async () => {
    const payload = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    expect(await decryptCredential(payload, "a-different-secret", CONTEXT)).toBeNull();
  });

  it("fails closed when the ciphertext is moved to another user or provider context", async () => {
    const payload = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    expect(await decryptCredential(payload, SECRET, "user-2:anthropic")).toBeNull();
    expect(await decryptCredential(payload, SECRET, "user-1:openai")).toBeNull();
  });

  it("fails closed on tampered or malformed payloads", async () => {
    const payload = await encryptCredential("sk-ant-example-1234", SECRET, CONTEXT);
    const [iv, ciphertext] = payload.split(".");
    const flipped = ciphertext.startsWith("A") ? `B${ciphertext.slice(1)}` : `A${ciphertext.slice(1)}`;
    expect(await decryptCredential(`${iv}.${flipped}`, SECRET, CONTEXT)).toBeNull();
    expect(await decryptCredential("not-a-payload", SECRET, CONTEXT)).toBeNull();
    expect(await decryptCredential("a.b.c", SECRET, CONTEXT)).toBeNull();
    expect(await decryptCredential("", SECRET, CONTEXT)).toBeNull();
  });
});
