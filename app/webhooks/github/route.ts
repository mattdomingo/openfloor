import { getGitHubAppConfig } from "@/db";
import { setUserGitHubInstallationStatus } from "@/db/github-installations";
import {
  findRepositoryWebhookTargets,
  recordGitHubWebhookDelivery,
  setRepositoryAvailability,
  touchRepositoryReview,
  updateRepositoryPullRequestState,
  updateRepositoryIdentity,
  updateRepositoryPushState,
} from "@/db/repositories";
import { endMergedSession } from "@/db/sessions";
import { applyCandidatePullRequestFeedback } from "@/lib/candidate-feedback";
import { verifyGitHubWebhookSignature } from "@/lib/github-state";
import { notifyFloorChanged, notifySessionEnded } from "@/lib/presence-server";
import { pokeSessionRouter } from "@/lib/router-server";

const MAX_WEBHOOK_BYTES = 1_000_000;

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const payload = await request.arrayBuffer();
  if (payload.byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const config = getGitHubAppConfig();
  const valid = await verifyGitHubWebhookSignature(
    payload,
    request.headers.get("x-hub-signature-256"),
    config.webhookSecret,
  );
  if (!valid) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  const event = request.headers.get("x-github-event") ?? "unknown";
  if (event === "ping") return Response.json({ accepted: true, event });
  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  if (!deliveryId || deliveryId.length > 200) return Response.json({ error: "Missing GitHub delivery ID" }, { status: 400 });
  let body: GitHubWebhookPayload;
  try {
    body = JSON.parse(new TextDecoder().decode(payload)) as GitHubWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
  const installationId = body.installation?.id == null ? null : String(body.installation.id);
  const repositoryId = body.repository?.id == null ? null : String(body.repository.id);
  const fresh = await recordGitHubWebhookDelivery(deliveryId, event, body.action ?? null, installationId, repositoryId);
  if (!fresh) return Response.json({ accepted: true, event, duplicate: true }, { status: 202 });
  if (event === "installation" && ["deleted", "suspend"].includes(body.action ?? "")) {
    await setUserGitHubInstallationStatus(installationId, "revoked");
  } else if (event === "installation" && ["created", "unsuspend", "new_permissions_accepted"].includes(body.action ?? "")) {
    await setUserGitHubInstallationStatus(installationId, "active");
  }
  const targets = await findRepositoryWebhookTargets(installationId, repositoryId);
  for (const target of targets) {
    let revision: number;
    let domains: Parameters<typeof notifyFloorChanged>[2] = ["repository", "runs", "review"];
    if (event === "installation" && ["deleted", "suspend"].includes(body.action ?? "")) {
      revision = await setRepositoryAvailability(target.sessionId, "revoked");
    } else if (event === "installation" && ["created", "unsuspend", "new_permissions_accepted"].includes(body.action ?? "")) {
      revision = await setRepositoryAvailability(target.sessionId, "connected");
    } else if (event === "installation_repositories") {
      const removed = body.repositories_removed?.some((repository) => String(repository.id) === target.repositoryId);
      const added = body.repositories_added?.some((repository) => String(repository.id) === target.repositoryId);
      if (!removed && !added) continue;
      revision = await setRepositoryAvailability(target.sessionId, removed ? "inaccessible" : "connected");
    } else if (event === "repository" && body.action === "deleted") {
      revision = await setRepositoryAvailability(target.sessionId, "inaccessible");
    } else if (event === "repository" && body.repository) {
      revision = await updateRepositoryIdentity(target.sessionId, {
        owner: body.repository.owner?.login ?? body.repository.full_name?.split("/")[0] ?? "",
        name: body.repository.name ?? body.repository.full_name?.split("/")[1] ?? "",
        fullName: body.repository.full_name ?? "",
      });
    } else if (event === "push" && body.ref && body.after) {
      revision = await updateRepositoryPushState(
        target.sessionId, body.ref, body.after, target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId,
      );
    } else if (event === "pull_request" && body.pull_request?.head?.ref && body.pull_request.number && body.pull_request.node_id && body.pull_request.html_url) {
      const headRef = body.pull_request.head.ref;
      const merged = body.pull_request.merged === true;
      revision = await updateRepositoryPullRequestState(target.sessionId, {
        number: body.pull_request.number,
        nodeId: body.pull_request.node_id,
        url: body.pull_request.html_url,
        state: body.pull_request.state === "closed" ? "closed" : "open",
        draft: body.pull_request.draft !== false,
        merged,
        mergeCommitSha: body.pull_request.merge_commit_sha ?? null,
        headRef,
      });
      // Merging the candidate branch ends the session's lifecycle, same as
      // the app's own squash-merge route — whichever path merges it first.
      // No branch cleanup here: this only marks the session ended, leaving
      // cleanup_status 'pending' as updateRepositoryPullRequestState set it.
      if (merged && headRef === target.candidateBranch) {
        const ended = await endMergedSession(target.sessionId);
        if (ended) await notifySessionEnded(target.sessionId, ended.endedAt, "merged");
      }
    } else if (FEEDBACK_EVENTS[event]?.(body.action ?? null) && concernsCandidatePullRequest(event, body, target)) {
      // Facts are re-fetched from GitHub rather than read off the payload:
      // one idempotent observation path regardless of delivery order.
      const outcome = await applyCandidatePullRequestFeedback(target.sessionId);
      revision = outcome.revision;
      if (outcome.nudged) {
        domains = ["queue", "repository", "runs", "review"];
        await pokeSessionRouter(target.sessionId, "enqueue");
      }
    } else {
      revision = await touchRepositoryReview(target.sessionId);
    }
    await notifyFloorChanged(target.sessionId, revision, domains);
  }
  return Response.json({ accepted: true, event }, { status: 202 });
}

type GitHubWebhookPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { id?: number | string; name?: string; full_name?: string; owner?: { login?: string } };
  repositories_removed?: Array<{ id?: number | string }>;
  repositories_added?: Array<{ id?: number | string }>;
  ref?: string;
  after?: string;
  pull_request?: { number?: number; node_id?: string; html_url?: string; state?: string; draft?: boolean; merged?: boolean; merge_commit_sha?: string; head?: { ref?: string } };
  // Identity fields only — feedback facts come from the re-fetch, never the payload.
  check_run?: { head_sha?: string; pull_requests?: Array<{ number?: number }> };
  check_suite?: { head_sha?: string; pull_requests?: Array<{ number?: number }> };
  sha?: string;
  branches?: Array<{ name?: string }>;
};

// Deliveries that can change the candidate PR's feedback facts, keyed by the
// action that carries new information (a completed check, a submitted
// review, a created comment). Everything else keeps the plain revision bump.
const FEEDBACK_EVENTS: Record<string, (action: string | null) => boolean> = {
  check_run: (action) => action === "completed",
  check_suite: (action) => action === "completed",
  status: () => true,
  pull_request_review: (action) => action === "submitted",
  pull_request_review_comment: (action) => action === "created",
};

function concernsCandidatePullRequest(
  event: string,
  body: GitHubWebhookPayload,
  target: Awaited<ReturnType<typeof findRepositoryWebhookTargets>>[number],
): boolean {
  if (!target.pullRequestNumber) return false;
  const shas = [target.candidateSha, target.remoteCandidateSha].filter((sha): sha is string => Boolean(sha));
  if (event === "check_run" || event === "check_suite") {
    const subject = event === "check_run" ? body.check_run : body.check_suite;
    return Boolean(subject?.pull_requests?.some((pullRequest) => pullRequest.number === target.pullRequestNumber)
      || (subject?.head_sha && shas.includes(subject.head_sha)));
  }
  if (event === "status") {
    return Boolean((body.sha && shas.includes(body.sha)) || body.branches?.some((branch) => branch.name === target.candidateBranch));
  }
  return body.pull_request?.node_id === target.pullRequestNodeId || body.pull_request?.number === target.pullRequestNumber;
}
