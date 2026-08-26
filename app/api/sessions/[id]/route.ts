import { deleteSession, updateSessionObjective } from "@/db/sessions";
import { abandonSessionCandidate } from "@/lib/candidate-abandon";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifyMembersChanged, notifySessionChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseObjectiveInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = parseObjectiveInput(body);
  if (!input) return Response.json({ error: "Objective must be 2,000 characters or fewer" }, { status: 400 });

  try {
    const session = await updateSessionObjective((await params).id, user.id, input.objective);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifySessionChanged(session.id, { objective: session.objective, updatedAt: session.updatedAt });
    return Response.json({ session });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;

  // Optional body: {} (no candidate to worry about, or the owner hasn't
  // decided yet — deleteSession below reports back if a live candidate
  // blocks it) or { candidate: "delete-branch" | "orphan" } once the owner
  // has chosen. Empty body is the common case and must keep working.
  const inputText = await request.text();
  let candidateChoice: "delete-branch" | "orphan" | null = null;
  if (inputText.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(inputText);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const raw = (body as { candidate?: unknown } | null)?.candidate;
    if (raw === "delete-branch" || raw === "orphan") candidateChoice = raw;
  }

  if (candidateChoice) {
    const abandonResult = await abandonSessionCandidate(sessionId, user.id, { deleteBranch: candidateChoice === "delete-branch" });
    if (abandonResult.outcome === "blocked") {
      return Response.json({ error: "The candidate is still being updated", runId: abandonResult.runId }, { status: 409 });
    }
    // "no_candidate" (already handled, or a benign race) and "abandoned"
    // both fall through — deleteSession below re-checks live state itself.
  }

  const result = await deleteSession(sessionId, user.id);
  if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
  if (result === "forbidden") return Response.json({ error: "Only the owner can delete this session" }, { status: 403 });
  if ("blocked" in result) {
    if (result.blocked === "integration_in_progress") {
      return Response.json({ error: "The candidate is still being updated", runId: result.runId }, { status: 409 });
    }
    return Response.json(
      {
        error: "This session's candidate branch hasn't merged yet — choose whether to delete it before deleting the session",
        code: "candidate_live",
        branch: result.branch,
        canDeleteBranch: result.sha != null,
      },
      { status: 409 },
    );
  }
  // members.changed makes open tabs refetch, hit the 404, and leave for /home.
  await notifyMembersChanged(sessionId);
  if (result.candidateBranchAlive) {
    return Response.json({ deleted: true, warning: "The candidate branch is still on GitHub — it was not deleted." }, { status: 200 });
  }
  return new Response(null, { status: 204 });
}
