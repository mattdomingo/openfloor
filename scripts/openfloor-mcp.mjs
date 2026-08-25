import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Spawned by the Codex CLI as a stdio MCP child, outside the agent's own
// network-disabled sandbox — this process is the one legitimate bridge back
// to live openfloor state. Talks only to /runtime/run/context with the
// run-scoped token it was given; it has no other capability.
const contextUrl = process.env.OPENFLOOR_CONTEXT_URL;
const contextToken = process.env.OPENFLOOR_CONTEXT_TOKEN;
const conflictInputUrl = process.env.OPENFLOOR_CONFLICT_INPUT_URL;
const conflictInputToken = process.env.OPENFLOOR_CONFLICT_INPUT_TOKEN;

const server = new McpServer({ name: "openfloor", version: "1.0.0" });

server.registerTool(
  "openfloor_session_context",
  {
    title: "Re-read the openfloor session",
    description: "Re-reads the current state of this openfloor session: every other agent and human on the floor, work already integrated into the candidate branch, runs happening right now with their live file edits, the rest of the queue, blocked or failed runs, and recent public team chat. The prompt you were given is a snapshot from when this run started — call this if the run has been going for a while and you want an up-to-date picture before finishing.",
  },
  async () => {
    if (!contextUrl || !contextToken) {
      return { content: [{ type: "text", text: "openfloor session context is unavailable in this run." }], isError: true };
    }
    try {
      const response = await fetch(contextUrl, { headers: { authorization: `Bearer ${contextToken}` } });
      if (!response.ok) {
        return { content: [{ type: "text", text: `openfloor session context is unavailable right now (status ${response.status}).` }], isError: true };
      }
      const text = await response.text();
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `openfloor session context request failed: ${message}` }], isError: true };
    }
  },
);

if (conflictInputUrl && conflictInputToken) {
  server.registerTool(
    "openfloor_request_conflict_input",
    {
      title: "Request conflict input",
      description: "Stop this merge-resolution attempt and ask the current session members for a product decision. Use only when the code cannot be resolved safely from repository and session intent. Provide a concise explanation and one to three specific questions.",
      inputSchema: {
        explanation: z.string().min(1).max(4_000),
        questions: z.array(z.string().min(1).max(500)).min(1).max(3),
      },
    },
    async ({ explanation, questions }) => {
      try {
        const response = await fetch(conflictInputUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${conflictInputToken}` },
          body: JSON.stringify({ explanation, questions }),
        });
        if (!response.ok) {
          return { content: [{ type: "text", text: `The conflict-input request was rejected (status ${response.status}).` }], isError: true };
        }
        return { content: [{ type: "text", text: "The questions were recorded. Stop work now; openfloor will discard this partial workspace and resume after a member answers." }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `The conflict-input request failed: ${message}` }], isError: true };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
