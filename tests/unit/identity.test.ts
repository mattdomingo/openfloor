import { afterEach, describe, expect, it } from "vitest";
import { identityFromHeaders, localDevelopmentIdentity } from "@/lib/identity";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("platform identity", () => {
  it("requires the stable ChatGPT user id and email", () => {
    expect(identityFromHeaders(new Headers({ "oai-authenticated-user-email": "person@example.com" }))).toBeNull();
    expect(identityFromHeaders(new Headers({ "oai-authenticated-user-id": "chatgpt-user" }))).toBeNull();
  });

  it("decodes the optional display name without using it as identity", () => {
    const identity = identityFromHeaders(new Headers({
      "oai-authenticated-user-id": "chatgpt-user-123",
      "oai-authenticated-user-email": "person@example.com",
      "oai-authenticated-user-full-name": "Ren%C3%A9e%20Smith",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    }));

    expect(identity).toEqual({
      providerUserId: "chatgpt-user-123",
      email: "person@example.com",
      fullName: "Renée Smith",
      displayName: "Renée Smith",
    });
  });
});

describe("development identity isolation", () => {
  it("only activates on loopback with explicit variables", () => {
    process.env.OPENFLOOR_DEV_USER_ID = "local-user";
    process.env.OPENFLOOR_DEV_USER_EMAIL = "local@example.com";
    process.env.OPENFLOOR_DEV_USER_NAME = "Local Person";

    expect(localDevelopmentIdentity(new Headers({ host: "opnflr.com" }))).toBeNull();
    expect(localDevelopmentIdentity(new Headers({ host: "localhost:3000" }))).toMatchObject({
      providerUserId: "local-user",
      displayName: "Local Person",
    });
  });

  it("stays disabled when the explicit variables are absent", () => {
    delete process.env.OPENFLOOR_DEV_USER_ID;
    delete process.env.OPENFLOOR_DEV_USER_EMAIL;
    expect(localDevelopmentIdentity(new Headers({ host: "127.0.0.1:3000" }))).toBeNull();
  });
});
