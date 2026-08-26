import { DurableObject } from "cloudflare:workers";
import { runRoutingTick, type RoutingTrigger } from "../db/routing";
import { disabledRunProviders, startConflictResolverRun, startQueueItemRun } from "../lib/agent-run-start";
import { notifyFloorChanged } from "../lib/presence-server";

const HELD_RETRY_BASE_MS = 10_000;
const HELD_RETRY_MAX_MS = 600_000;
const ERROR_RETRY_MS = 60_000;

// The earlier of a computed retry time and a pending TickOutcome.wakeAt
// (db/routing.ts) — a generated agent idling out its retirement grace window
// must never wait longer than whatever else the alarm was already going to
// fire for.
function nearestWake(candidate: number, wakeAt: number | null): number {
  return wakeAt !== null ? Math.min(candidate, wakeAt) : candidate;
}

/**
 * Per-session routing loop. Pokes only record the trigger and schedule an
 * immediate alarm; all work happens in alarm(), which never overlaps with
 * itself — giving serialization, poke coalescing, and eviction durability
 * for free. Idempotency of the tick itself lives in db/routing.ts (guarded
 * assignment UPDATE) and the one-active-run-per-item unique index.
 */
export class SessionRouter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/poke") return new Response(null, { status: 404 });
    const body = (await request.json().catch(() => null)) as { sessionId?: string; trigger?: RoutingTrigger } | null;
    if (!body?.sessionId) return new Response(null, { status: 400 });
    // The DO cannot recover its own name, so the poke carries the session id.
    await this.ctx.storage.put("sessionId", body.sessionId);
    await this.ctx.storage.put("trigger", body.trigger ?? "alarm");
    await this.ctx.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>("sessionId");
    if (!sessionId) return;
    const trigger = (await this.ctx.storage.get<RoutingTrigger>("trigger")) ?? "alarm";
    try {
      const outcome = await runRoutingTick(sessionId, trigger, { startRun: startQueueItemRun, startConflictResolution: startConflictResolverRun, disabledProviders: disabledRunProviders() });
      if (outcome.revision !== null) {
        await notifyFloorChanged(sessionId, outcome.revision, ["agents", "queue", "runs"]);
      }
      if (outcome.held) {
        const misses = ((await this.ctx.storage.get<number>("misses")) ?? 0) + 1;
        await this.ctx.storage.put("misses", misses);
        await this.ctx.storage.put("trigger", "alarm");
        const heldRetryAt = Date.now() + Math.min(HELD_RETRY_BASE_MS * 2 ** (misses - 1), HELD_RETRY_MAX_MS);
        await this.ctx.storage.setAlarm(nearestWake(heldRetryAt, outcome.wakeAt));
      } else if (outcome.acted) {
        // A dispatched run may already be terminal (test adapter runs
        // synchronously); one inline follow-up tick picks up freed capacity
        // without waiting out an alarm hop. Anything it leaves behind falls
        // back to the alarm path with the same semantics as before.
        await this.ctx.storage.delete("misses");
        await this.ctx.storage.put("trigger", "alarm");
        const followUp = await runRoutingTick(sessionId, "alarm", { startRun: startQueueItemRun, startConflictResolution: startConflictResolverRun, disabledProviders: disabledRunProviders() });
        if (followUp.revision !== null) {
          await notifyFloorChanged(sessionId, followUp.revision, ["agents", "queue", "runs"]);
        }
        if (followUp.held || followUp.acted) {
          await this.ctx.storage.setAlarm(nearestWake(Date.now() + 1_000, followUp.wakeAt));
        } else if (followUp.wakeAt !== null) {
          // Quiescent follow-up, but a generated agent is still idling out
          // its retirement grace window (db/floor.ts) — wake for that alone.
          await this.ctx.storage.setAlarm(followUp.wakeAt);
        }
      } else if (outcome.wakeAt !== null) {
        // Quiescent, but a generated agent is idling out its retirement
        // grace window — wake for that alone, or the linger would depend on
        // an unrelated poke and could last indefinitely on a quiet floor.
        await this.ctx.storage.delete("misses");
        await this.ctx.storage.setAlarm(outcome.wakeAt);
      } else {
        // Quiescent: no alarm scheduled; the next poke re-wakes us.
        await this.ctx.storage.delete("misses");
      }
    } catch {
      await this.ctx.storage.put("trigger", "alarm");
      await this.ctx.storage.setAlarm(Date.now() + ERROR_RETRY_MS);
    }
  }
}
