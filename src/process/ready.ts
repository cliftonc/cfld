/**
 * Readiness + live stats via cloudflared's metrics server. `/ready` returning
 * 200 is the authoritative "tunnel is live" signal; `/metrics` (Prometheus
 * text) feeds the dashboard's connection/request/latency counters.
 */

export interface ReadyState {
  ready: boolean;
  connections: number;
}

async function getReady(metricsPort: number): Promise<ReadyState | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/ready`);
    if (res.status !== 200) return { ready: false, connections: 0 };
    const body = (await res.json()) as { readyConnections?: number };
    return { ready: true, connections: body.readyConnections ?? 0 };
  } catch {
    return undefined; // metrics server not up yet
  }
}

/**
 * Poll `/ready` until 200 or timeout. Aborts early if the signal fires (e.g.
 * the user hit Ctrl-C, or the child died).
 */
export async function waitForReady(
  metricsPort: number,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<ReadyState> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const state = await getReady(metricsPort);
    if (state?.ready) return state;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for the tunnel to connect to Cloudflare.");
}

export interface Metrics {
  connections: number;
  requests: number;
  /** Average origin round-trip in ms, if the histogram is exposed. */
  avgLatencyMs?: number;
}

/** Scrape a snapshot of counters from the Prometheus metrics endpoint. */
export async function scrapeMetrics(
  metricsPort: number,
): Promise<Metrics | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    if (res.status !== 200) return undefined;
    const text = await res.text();
    return parseMetrics(text);
  } catch {
    return undefined;
  }
}

/** Pure parse of Prometheus text — separated so it's unit-testable. */
export function parseMetrics(text: string): Metrics {
  const requests =
    sumMetric(text, "cloudflared_tunnel_total_requests") ||
    sumMetric(text, "cloudflared_tunnel_request_errors");
  const durSum = sumMetric(text, "cloudflared_tunnel_request_duration_seconds_sum");
  const durCount = sumMetric(text, "cloudflared_tunnel_request_duration_seconds_count");
  const avgLatencyMs =
    durCount > 0 ? Math.round((durSum / durCount) * 1000) : undefined;
  return {
    connections: sumMetric(text, "cloudflared_tunnel_ha_connections"),
    requests,
    avgLatencyMs,
  };
}

/** Sum all samples of a metric family (ignores labels). */
function sumMetric(text: string, name: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const value = Number(line.trim().split(/\s+/).pop());
    if (!Number.isNaN(value)) total += value;
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
