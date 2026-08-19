import { readFile, writeFile } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";

const promptPath = process.env.OPENFLOOR_PROMPT_PATH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const workspace = process.env.OPENFLOOR_WORKSPACE;
const gatewayUrl = process.env.OPENFLOOR_OPENAI_BASE_URL;
const gatewayToken = process.env.OPENFLOOR_OPENAI_TOKEN;
const model = process.env.OPENFLOOR_MODEL;

if (!promptPath || !resultPath || !workspace || !gatewayUrl || !gatewayToken || !model) {
  throw new Error("OpenFloor Codex runner configuration is incomplete");
}

const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

const prompt = await readFile(promptPath, "utf8");
const codex = new Codex({ baseUrl: gatewayUrl, apiKey: gatewayToken });
const thread = codex.startThread({
  model,
  workingDirectory: workspace,
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
});

let threadId = null;
let finalResponse = null;
let usage = null;
try {
  const streamed = await thread.runStreamed(prompt, { signal: controller.signal });
  for await (const event of streamed.events) {
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
    const encoded = JSON.stringify(event);
    process.stdout.write(`${encoded.length > 20_000 ? `${encoded.slice(0, 20_000)}…` : encoded}\n`);
  }
  await writeFile(resultPath, JSON.stringify({ ok: true, threadId: threadId ?? thread.id, finalResponse, usage }), "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId: threadId ?? thread.id, finalResponse, error: message }), "utf8");
  process.stderr.write(`${message}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
