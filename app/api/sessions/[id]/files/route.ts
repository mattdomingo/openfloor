import { createSessionFiles } from "@/db/floor";
import { getActiveMembershipRole } from "@/db/sessions";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import {
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_FILES_PER_UPLOAD,
  sanitizeSessionFileName,
} from "@/lib/session-file-constraints";
import { deleteSessionFileObjects, putSessionFileObject, sessionFileKey } from "@/lib/session-files";

// Multipart upload of session files (ENG-113): bytes to R2, rows to D1, and
// the response carries fileIds so the chat composer can link them to the
// message it sends next. Membership is checked before any byte reaches R2.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  try {
    if (!(await getActiveMembershipRole(sessionId, user.id))) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
  } catch (error) {
    return mutationErrorResponse(error);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Send files as multipart form data" }, { status: 400 });
  }
  const uploads = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (uploads.length === 0 || uploads.length > MAX_SESSION_FILES_PER_UPLOAD) {
    return Response.json({ error: `Attach between 1 and ${MAX_SESSION_FILES_PER_UPLOAD} files` }, { status: 400 });
  }
  if (uploads.some((file) => file.size === 0 || file.size > MAX_SESSION_FILE_BYTES)) {
    return Response.json({ error: "Each file must be between 1 byte and 8MB" }, { status: 400 });
  }

  const files = uploads.map((file) => {
    const id = crypto.randomUUID();
    return {
      id,
      file,
      name: sanitizeSessionFileName(file.name),
      r2Key: sessionFileKey(sessionId, id),
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    };
  });
  for (const upload of files) {
    if (!(await putSessionFileObject(upload.r2Key, upload.file))) {
      return Response.json({ error: "File sharing is unavailable" }, { status: 503 });
    }
  }
  try {
    const floor = await createSessionFiles(sessionId, user.id, files);
    if (!floor) {
      await deleteSessionFileObjects(files.map((upload) => upload.r2Key));
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    await notifyFloorChanged(sessionId, floor.revision, ["messages"]);
    return Response.json({ floor, fileIds: files.map((upload) => upload.id) }, { status: 201 });
  } catch (error) {
    await deleteSessionFileObjects(files.map((upload) => upload.r2Key));
    return mutationErrorResponse(error);
  }
}
