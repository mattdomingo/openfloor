"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { RunActivityEvent } from "@/lib/floor-types";

const MAX_EVENTS_PER_RUN = 200;

export type RunActivitySource = {
  eventsFor(runId: string): RunActivityEvent[];
  ingest(payload: { runId: string; events: RunActivityEvent[] }): void;
  catchUp(runIds: string[]): void;
  loadTimeline(runId: string): void;
};

function merge(current: RunActivityEvent[] | undefined, incoming: RunActivityEvent[]): RunActivityEvent[] {
  const bySequence = new Map<number, RunActivityEvent>();
  for (const event of current ?? []) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_EVENTS_PER_RUN);
}

export function useRunActivity(sessionId: string): RunActivitySource {
  const [eventsByRun, setEventsByRun] = useState<ReadonlyMap<string, RunActivityEvent[]>>(new Map());
  const eventsRef = useRef(eventsByRun);
  useEffect(() => { eventsRef.current = eventsByRun; }, [eventsByRun]);
  const loadingRef = useRef(new Set<string>());

  const store = useCallback((runId: string, incoming: RunActivityEvent[]) => {
    if (incoming.length === 0) return;
    setEventsByRun((current) => {
      const next = new Map(current);
      next.set(runId, merge(current.get(runId), incoming));
      return next;
    });
  }, []);

  const fetchEvents = useCallback(async (runId: string, after: number) => {
    if (loadingRef.current.has(runId)) return;
    loadingRef.current.add(runId);
    try {
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/runs/${runId}/events?after=${after}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { events: RunActivityEvent[] };
      store(runId, body.events);
    } catch {
      // Broadcasts and the next catch-up close any gap a failed fetch leaves.
    } finally {
      loadingRef.current.delete(runId);
    }
  }, [sessionId, store]);

  const ingest = useCallback((payload: { runId: string; events: RunActivityEvent[] }) => {
    store(payload.runId, payload.events);
  }, [store]);

  const catchUp = useCallback((runIds: string[]) => {
    for (const runId of runIds) {
      const known = eventsRef.current.get(runId);
      void fetchEvents(runId, known?.length ? known[known.length - 1].sequence : 0);
    }
  }, [fetchEvents]);

  const loadTimeline = useCallback((runId: string) => {
    if (!eventsRef.current.get(runId)?.length) void fetchEvents(runId, 0);
  }, [fetchEvents]);

  const eventsFor = useCallback((runId: string) => eventsByRun.get(runId) ?? [], [eventsByRun]);

  return useMemo(() => ({ eventsFor, ingest, catchUp, loadTimeline }), [eventsFor, ingest, catchUp, loadTimeline]);
}
