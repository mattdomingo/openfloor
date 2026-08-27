import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding, testRepositorySelection } from "./github-fixture";

function identity(id: string) {
  return {
    accept: "application/json",
    host: "localhost",
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": `${id}@example.com`,
    "x-openfloor-dev-user-name": `User ${id}`,
  };
}

async function createOwnedSession(id: string) {
  const headers = identity(id);
  await completeTestOnboarding(headers, "Files", "Owner");
  const response = await SELF.fetch("http://localhost/api/sessions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: `Files ${id}`, ...await testRepositorySelection(headers) }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { session: { id: string } };
  return { headers, sessionId: body.session.id };
}

function upload(sessionId: string, headers: Record<string, string>, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return SELF.fetch(`http://localhost/api/sessions/${sessionId}/files`, { method: "POST", headers, body: form });
}

describe("session files", () => {
  it("uploads, links to a team message, and serves to members only", async () => {
    const { headers, sessionId } = await createOwnedSession("session-files-owner");

    const uploaded = await upload(sessionId, headers, [
      new File([new Uint8Array([137, 80, 78, 71])], "diagram.png", { type: "image/png" }),
      new File(["hello notes"], "notes.txt", { type: "text/plain" }),
    ]);
    expect(uploaded.status).toBe(201);
    const uploadBody = await uploaded.json() as { fileIds: string[]; floor: { files: Array<{ id: string; name: string; messageId: string | null }> } };
    expect(uploadBody.fileIds).toHaveLength(2);
    expect(uploadBody.floor.files).toHaveLength(2);
    expect(uploadBody.floor.files.every((file) => file.messageId === null)).toBe(true);

    // A team message claims the sender's unattached uploads.
    const message = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "see attached", recipientUserId: null, attachmentIds: uploadBody.fileIds }),
    });
    expect(message.status).toBe(201);
    const messageBody = await message.json() as { floor: { messages: Array<{ id: string; text: string }>; files: Array<{ id: string; messageId: string | null }> } };
    const sent = messageBody.floor.messages.find((entry) => entry.text === "see attached");
    expect(sent).toBeDefined();
    expect(messageBody.floor.files.map((file) => file.messageId)).toEqual([sent!.id, sent!.id]);

    // Serving: image inline, text as attachment, both nosniff.
    const png = uploadBody.floor.files.find((file) => file.name === "diagram.png")!;
    const image = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/files/${png.id}`, { headers });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-disposition")).toContain("inline");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    const text = uploadBody.floor.files.find((file) => file.name === "notes.txt")!;
    const download = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/files/${text.id}`, { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe("hello notes");

    // A non-member sees the same 404 as a nonexistent file, and can't upload.
    const outsider = identity("session-files-outsider");
    await completeTestOnboarding(outsider, "Out", "Sider");
    const concealedRead = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/files/${png.id}`, { headers: outsider });
    expect(concealedRead.status).toBe(404);
    const concealedWrite = await upload(sessionId, outsider, [new File(["x"], "x.txt", { type: "text/plain" })]);
    expect(concealedWrite.status).toBe(404);
  });

  it("refuses attachments on direct messages", async () => {
    const { headers, sessionId } = await createOwnedSession("session-files-dm");
    const uploaded = await upload(sessionId, headers, [new File(["dm"], "dm.txt", { type: "text/plain" })]);
    expect(uploaded.status).toBe(201);
    const { fileIds } = await uploaded.json() as { fileIds: string[] };
    const dm = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "psst", recipientUserId: "someone", attachmentIds: fileIds }),
    });
    expect(dm.status).toBe(400);
  });
});
