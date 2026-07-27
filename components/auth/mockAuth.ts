/* Fully simulated client-side "auth" for this mocked prototype — no backend,
   no real credential storage. Just enough state to gate /home and /session/[id]
   behind something that looks like a login. */

export type MockUser = {
  name: string;
  email: string;
};

const STORAGE_KEY = "openfloor:mock-user";

export function getMockUser(): MockUser | null {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as MockUser;
  } catch {
    return null;
  }
}

export function setMockUser(user: MockUser) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function clearMockUser() {
  window.localStorage.removeItem(STORAGE_KEY);
}

/* Turns an email into a plausible display name when registering/joining without one. */
export function nameFromEmail(email: string): string {
  const handle = email.split("@")[0] ?? email;
  return handle
    .split(/[.\-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
