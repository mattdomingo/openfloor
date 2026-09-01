// Read-only bootstrap endpoints for native (non-browser) clients — the
// desktop app. Each branch mirrors, exactly, the data assembly of the RSC
// page it corresponds to (app/home, app/home/settings, app/onboarding,
// app/session/[id], app/session/[id]/floor, app/join/[token]); the client
// renders the same screen components from these props. Pages redirect;
// this returns { redirect } for the client's router to honor. No mutations,
// no new authorization surface: every read goes through the same
// member-scoped db functions the pages use.
import { getAccessUser, safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { getInviteSigningSecret } from "@/db";
import { getBillingSummary } from "@/db/billing";
import { getFloorSnapshot } from "@/db/floor";
import { listUserGitHubInstallations } from "@/db/github-installations";
import { listSessionMcpServersForMember } from "@/db/mcp-servers";
import { getLatestRepositoryPreflightForMember } from "@/db/preflights";
import { getMonthlyModelUsage, listProviderCredentials } from "@/db/provider-credentials";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import {
  getInvitePreview,
  getMembershipRole,
  getOwnerHourQuota,
  getRemovedSessionMembers,
  getSessionForMember,
  getSessionMembers,
  getUsageForUser,
  listSessionsForUser,
  upsertUser,
} from "@/db/sessions";
import { listSessionSkillsForMember } from "@/db/skills";
import { normalizedTeamDomain } from "@/lib/identity";
import { verifyInviteToken } from "@/lib/invites";
import { parseOnboardingStep } from "@/lib/onboarding-plan";
import { lowHoursRemaining, PLAN_LIMITS } from "@/lib/plans";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { isRepositoryReadyForFloor } from "@/lib/repository-gate";
import type { AppUser } from "@/lib/session-types";
import { isSettingsSection } from "@/lib/settings-plan";
import { resolveSettingsOrigin } from "@/app/home/settings/origin";
import { env } from "cloudflare:workers";
import { earlyAccessPath } from "@/lib/access-paths";
import { earlyAccessGateEnabled, hasEarlyAccess } from "@/lib/early-access";

const unauthenticated = () => Response.json({ error: "Authentication required" }, { status: 401 });
const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
const redirectTo = (path: string) => Response.json({ redirect: path });

function onboardingRedirect(returnTo: string): Response {
  const appReturnTo = `${BASE_PATH}${returnTo === "/" ? "" : returnTo}` || "/";
  return redirectTo(`/onboarding?return_to=${encodeURIComponent(appReturnTo)}`);
}

function enabledProviders() {
  const disabled = disabledRunProviders();
  return CREDENTIAL_PROVIDERS.filter((provider) => !disabled.has(provider));
}

export async function GET(request: Request, { params }: { params: Promise<{ route: string[] }> }) {
  const identity = await getAccessUser();
  if (!identity) return unauthenticated();
  const user = await upsertUser(identity);
  const { route } = await params;
  const query = new URL(request.url).searchParams;
  const [head, ...rest] = route;

  if (earlyAccessGateEnabled(env as unknown as Record<string, string | undefined>) && !hasEarlyAccess(user)) {
    return redirectTo(earlyAccessPath(bootstrapReturnPath(head, rest, query)));
  }

  if (head === "me" && rest.length === 0) {
    return Response.json({ user, onboarded: user.onboardedAt != null });
  }

  if (head === "onboarding" && rest.length === 0) {
    const returnTo = safeAppReturnPath(query.get("return_to") ?? undefined) ?? `${BASE_PATH}/home`;
    if (user.onboardedAt != null) return redirectTo(returnTo);
    const [githubInstallations, credentials] = await Promise.all([
      listUserGitHubInstallations(user.id),
      listProviderCredentials(user.id),
    ]);
    const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
    return Response.json({
      props: {
        fullName: identity.fullName,
        firstName: user.firstName,
        lastName: user.lastName,
        githubHandle: user.githubHandle,
        returnTo,
        githubInstallations,
        initialCredentials: credentials,
        initialStep: parseOnboardingStep(query.get("step") ?? undefined),
        teamLogoutUrl: teamDomain ? `${teamDomain}/cdn-cgi/access/logout` : null,
      },
    });
  }

  // Everything below is gated behind completed onboarding, like the pages.
  const gate = (returnTo: string): Response | AppUser =>
    user.onboardedAt == null ? onboardingRedirect(returnTo) : user;

  if (head === "home" && rest.length === 0) {
    const gated = gate("/home");
    if (gated instanceof Response) return gated;
    const [sessions, usage, initialCredentials, modelUsage] = await Promise.all([
      listSessionsForUser(user.id),
      getUsageForUser(user.id),
      listProviderCredentials(user.id),
      getMonthlyModelUsage(user.id),
    ]);
    return Response.json({ props: { user, sessions, usage, initialCredentials, enabledProviders: enabledProviders(), modelUsage } });
  }

  if (head === "settings" && rest.length === 0) {
    const gated = gate("/home/settings");
    if (gated instanceof Response) return gated;
    const [usage, billing, credentials, githubInstallations, origin, modelUsage] = await Promise.all([
      getUsageForUser(user.id),
      getBillingSummary(user.id),
      listProviderCredentials(user.id),
      listUserGitHubInstallations(user.id),
      resolveSettingsOrigin(query.get("from") ?? undefined, user.id),
      getMonthlyModelUsage(user.id),
    ]);
    const section = query.get("section") ?? undefined;
    return Response.json({
      props: {
        user,
        usage,
        billing,
        credentials,
        githubInstallations,
        modelUsage,
        initialSection: isSettingsSection(section) ? section : "profile",
        billingNotice: query.get("billing"),
        backTo: origin,
        originPath: origin.href === "/home" ? null : origin.href,
      },
    });
  }

  if (head === "session" && rest.length === 1) {
    const id = rest[0];
    const gated = gate(`/session/${encodeURIComponent(id)}`);
    if (gated instanceof Response) return gated;
    const [session, members, removedMembers, repository, candidate, preflight, skills, mcpServers, quota, credentials] =
      await Promise.all([
        getSessionForMember(id, user.id),
        getSessionMembers(id, user.id),
        getRemovedSessionMembers(id, user.id),
        getRepositoryConnectionForMember(id, user.id),
        getActiveRepositoryCandidateForMember(id, user.id),
        getLatestRepositoryPreflightForMember(id, user.id),
        listSessionSkillsForMember(id, user.id),
        listSessionMcpServersForMember(id, user.id),
        getOwnerHourQuota(id),
        listProviderCredentials(user.id),
      ]);
    if (!session || !members) return notFound();
    return Response.json({
      props: {
        user,
        session,
        initialMembers: members,
        initialRemovedMembers: removedMembers ?? [],
        initialRepository: repository,
        initialCandidate: candidate,
        initialPreflight: preflight,
        preflightEnabled: (env as unknown as { PREFLIGHT_ENABLED?: string }).PREFLIGHT_ENABLED === "true",
        enabledProviders: enabledProviders(),
        initialCredentials: credentials,
        initialSkills: skills ?? [],
        initialMcpServers: mcpServers ?? [],
        repoGateRequested: query.get("repo") === "required",
        lowHoursRemaining: quota ? lowHoursRemaining(quota.seconds, PLAN_LIMITS[quota.plan].hours) : null,
      },
    });
  }

  if (head === "session" && rest.length === 2 && rest[1] === "floor") {
    const id = rest[0];
    const gated = gate(`/session/${encodeURIComponent(id)}/floor`);
    if (gated instanceof Response) return gated;
    const [session, members, floor, repository, candidate, credentials, quota] = await Promise.all([
      getSessionForMember(id, user.id),
      getSessionMembers(id, user.id),
      getFloorSnapshot(id, user.id),
      getRepositoryConnectionForMember(id, user.id),
      getActiveRepositoryCandidateForMember(id, user.id),
      listProviderCredentials(user.id),
      getOwnerHourQuota(id),
    ]);
    if (!session || !members || !floor) return notFound();
    if (session.endedAt != null) return redirectTo(`/session/${encodeURIComponent(id)}`);
    if (!isRepositoryReadyForFloor(repository, candidate)) {
      return redirectTo(`/session/${encodeURIComponent(id)}?repo=required`);
    }
    return Response.json({
      props: {
        user,
        session,
        initialMembers: members,
        initialFloor: floor,
        agentRunEnabled: (env as unknown as { AGENT_RUN_ENABLED?: string }).AGENT_RUN_ENABLED === "true",
        enabledProviders: enabledProviders(),
        providerCredentials: credentials,
        lowHoursRemaining: quota ? lowHoursRemaining(quota.seconds, PLAN_LIMITS[quota.plan].hours) : null,
      },
    });
  }

  if (head === "join" && rest.length === 1) {
    const token = rest[0];
    const gated = gate(`/join/${encodeURIComponent(token)}`);
    if (gated instanceof Response) return gated;
    const inviteId = await verifyInviteToken(token, getInviteSigningSecret());
    if (!inviteId) return notFound();
    const preview = await getInvitePreview(inviteId);
    if (!preview) return notFound();
    const alreadyMember = Boolean(await getMembershipRole(preview.sessionId, user.id));
    return Response.json({ props: { token, preview, displayName: user.displayName, alreadyMember } });
  }

  return notFound();
}

function bootstrapReturnPath(head: string | undefined, rest: string[], query: URLSearchParams): string {
  if (head === "onboarding") return safeAppReturnPath(query.get("return_to")) ?? `${BASE_PATH}/home`;
  if (head === "settings") return `${BASE_PATH}/home/settings`;
  if (head === "session" && rest.length > 0) {
    const suffix = rest[1] === "floor" ? "/floor" : "";
    return `${BASE_PATH}/session/${encodeURIComponent(rest[0])}${suffix}`;
  }
  if (head === "join" && rest.length > 0) return `${BASE_PATH}/join/${encodeURIComponent(rest[0])}`;
  return `${BASE_PATH}/home`;
}
