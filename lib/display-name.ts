// Single home for deriving a user's display name and initials, shared by
// onboarding, account settings, and every avatar-adjacent component. Kept
// dependency-free (no cloudflare:workers import) so it's reachable from
// tests/unit under plain node, same rationale as lib/plans.ts.

// The stored display_name is always "First L." — never the raw full name —
// so onboarding and account settings can never disagree on the format.
/** "1 repository" / "3 repositories"; null (legacy unscoped link) shows nothing. */
export function repoCountLabel(repoCount: number | null): string | null {
  if (repoCount == null) return null;
  return repoCount === 1 ? "1 repository" : `${repoCount} repositories`;
}

export function displayNameFrom(firstName: string, lastName: string): string {
  return `${firstName} ${lastName.charAt(0)}.`;
}

// Stored display_name stays "First L." in full. The UI shortens only the
// given-name token when it would blow a chip, heading, or attribution row.
export const GIVEN_NAME_VISIBLE = 14;

export function visiblePersonName(displayName: string, maxGiven = GIVEN_NAME_VISIBLE): { text: string; full: string; truncated: boolean } {
  const trimmed = displayName.trim();
  const space = trimmed.search(/\s/);
  const given = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space);
  if (given.length <= maxGiven) return { text: trimmed, full: trimmed, truncated: false };
  return { text: `${given.slice(0, maxGiven)}…${rest}`, full: trimmed, truncated: true };
}

// Initials derived from an existing display name (used wherever only the
// AppUser/SessionMember is available, e.g. avatars in rosters and chat).
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

// Initials derived directly from in-progress first/last name form fields,
// before a display name has been computed (onboarding and profile-edit
// pickers, which preview initials as the user types). Always shows a
// character for firstName (falling back to "?"), and only shows lastName's
// initial once it has been typed — matches the original onboarding-picker
// behavior verbatim.
export function initialsFromParts(firstName: string, lastName: string): string {
  return (firstName[0] ?? "?").toUpperCase() + (lastName[0] ?? "").toUpperCase();
}
