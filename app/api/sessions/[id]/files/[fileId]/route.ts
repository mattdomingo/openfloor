import { getSessionFileForMember } from "@/db/floor";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { INLINE_SESSION_FILE_TYPES } from "@/lib/session-file-constraints";
import { getSessionFileObject } from "@/lib/session-files";

// Streams one shared session file to a member. Non-members and nonexistent
// files get the same 404 (concealment). Only image types render inline;
// everything else downloads, so an uploaded HTML or SVG file can never
// script the app origin — nosniff keeps the browser honest about it.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, fileId } = await params;

  const file = await getSessionFileForMember(sessionId, fileId, user.id);
  if (!file) return new Response(null, { status: 404 });

  const object = await getSessionFileObject(file.r2Key);
  if (!object) return new Response(null, { status: 404 });

  const inline = INLINE_SESSION_FILE_TYPES.has(file.contentType);
  return new Response(object.body, {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/["\\]/g, "")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    },
  });
}
