import { handlePresenceRequest, SessionPresence } from "../../worker/presence";

export { SessionPresence };

const worker = {
  async fetch(request: Request, env: Cloudflare.Env) {
    return (await handlePresenceRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
};

export default worker;
