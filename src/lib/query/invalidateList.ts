import type { QueryClient } from "@tanstack/react-query";

export function invalidateList(qc: QueryClient, endpoint: string): Promise<void> {
  return qc.invalidateQueries({ queryKey: ["list", endpoint] });
}

export function invalidateListMetrics(qc: QueryClient, metricEndpoint: string): Promise<void> {
  return qc.invalidateQueries({ queryKey: ["list-metrics", metricEndpoint] });
}