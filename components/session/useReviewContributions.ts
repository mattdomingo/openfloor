"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { ReviewContribution, ReviewContributionPage } from "@/lib/floor-types";

type Filters = {
  status: "active" | "rolled_back";
  path?: string | null;
  engineerId?: string | null;
  agentId?: string | null;
  enabled?: boolean;
};

const EMPTY_PAGE: ReviewContributionPage = { items: [], nextCursor: null, engineers: [], agents: [] };

export function useReviewContributions(sessionId: string, revision: number, filters: Filters) {
  const [result, setResult] = useState<{ key: string; page: ReviewContributionPage; error: string | null } | null>(null);
  const inFlight = useRef(new Set<string>());
  const filterKey = useMemo(
    () => JSON.stringify([filters.status, filters.path ?? null, filters.engineerId ?? null, filters.agentId ?? null, filters.enabled !== false]),
    [filters.agentId, filters.enabled, filters.engineerId, filters.path, filters.status],
  );
  const requestKey = `${revision}:${filterKey}`;
  const page = result?.key === requestKey ? result.page : EMPTY_PAGE;

  const load = useCallback(async (cursor?: string | null) => {
    if (filters.enabled === false) return;
    const flightKey = `${requestKey}:${cursor ?? "first"}`;
    if (inFlight.current.has(flightKey)) return;
    inFlight.current.add(flightKey);
    try {
      const query = new URLSearchParams({ status: filters.status, limit: "25" });
      if (cursor) query.set("cursor", cursor);
      if (filters.path) query.set("path", filters.path);
      if (filters.engineerId) query.set("engineerId", filters.engineerId);
      if (filters.agentId) query.set("agentId", filters.agentId);
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/contributions?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Contributions could not be loaded");
      const next = await response.json() as ReviewContributionPage;
      setResult((current) => ({
        key: requestKey,
        page: cursor && current?.key === requestKey ? { ...next, items: [...current.page.items, ...next.items] } : next,
        error: null,
      }));
    } catch (loadError) {
      setResult((current) => ({
        key: requestKey,
        page: current?.key === requestKey ? current.page : EMPTY_PAGE,
        error: loadError instanceof Error ? loadError.message : "Contributions could not be loaded",
      }));
    } finally {
      inFlight.current.delete(flightKey);
    }
  }, [filters.agentId, filters.enabled, filters.engineerId, filters.path, filters.status, requestKey, sessionId]);

  useEffect(() => {
    if (filters.enabled !== false) void load();
  }, [filterKey, load, revision, filters.enabled]);

  return {
    ...page,
    loading: filters.enabled !== false && result?.key !== requestKey,
    error: result?.key === requestKey ? result.error : null,
    loadMore: () => page.nextCursor ? load(page.nextCursor) : Promise.resolve(),
  };
}

export function useReviewContributionDetail(sessionId: string, revision: number, runId: string | null) {
  const requestKey = `${revision}:${runId ?? "none"}`;
  const [result, setResult] = useState<{ key: string; contribution: ReviewContribution | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    void fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/contributions/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Prompt changes could not be loaded");
        return response.json() as Promise<{ contribution: ReviewContribution }>;
      })
      .then((responseResult) => { if (!cancelled) setResult({ key: requestKey, contribution: responseResult.contribution, error: null }); })
      .catch((loadError) => { if (!cancelled) setResult({ key: requestKey, contribution: null, error: loadError instanceof Error ? loadError.message : "Prompt changes could not be loaded" }); });
    return () => { cancelled = true; };
  }, [requestKey, runId, sessionId]);
  if (!runId) return { contribution: null, loading: false, error: null };
  return result?.key === requestKey
    ? { contribution: result.contribution, loading: false, error: result.error }
    : { contribution: null, loading: true, error: null };
}
