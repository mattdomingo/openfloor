import { getChatGPTUser } from "@/app/chatgpt-auth";
import { upsertUser } from "@/db/sessions";
import type { AppUser } from "@/lib/session-types";

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const identity = await getChatGPTUser();
  return identity ? upsertUser(identity) : null;
}

export async function requireApiUser(): Promise<AppUser | Response> {
  const user = await getCurrentAppUser();
  return user ?? Response.json({ error: "Authentication required" }, { status: 401 });
}

export function isApiError(value: AppUser | Response): value is Response {
  return value instanceof Response;
}
