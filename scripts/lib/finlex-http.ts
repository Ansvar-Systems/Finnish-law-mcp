/**
 * Shared HTTP helper for Finlex open-data acquisition (issue #78).
 * Port of Dutch-law-mcp src/ingest/http-retry.ts (merged dutch-law#117/#120).
 *
 * Transient failures (5xx, 429, thrown network errors) retry with backoff and
 * then THROW. They are never soft-failed to null or skipped, so a flaky
 * network can never be recorded as "document gone upstream". Non-retryable
 * client errors (404 and other 4xx) are returned for the caller to interpret:
 * a 404 on a statute-consolidated fetch IS a finding (no consolidation
 * published), not an error.
 */

export const FINLEX_USER_AGENT =
  'Finnish-Law-MCP/1.2.3 (https://github.com/Ansvar-Systems/Finnish-law-mcp)';

/** Politeness floor for requests against opendata.finlex.fi (>=2s per request). */
export const FINLEX_REQUEST_DELAY_MS = 2000;

const DEFAULT_BACKOFF_MS = [2_000, 4_000, 8_000];

export function politeDelay(ms: number = FINLEX_REQUEST_DELAY_MS): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  opts: {
    fetchImpl?: typeof fetch;
    attempts?: number;
    backoffMs?: number[];
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 4;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const headers = opts.headers ?? { 'User-Agent': FINLEX_USER_AGENT };
  let lastProblem = 'unknown';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', headers });
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) {
        lastProblem = `HTTP ${res.status}`;
      } else {
        return res; // non-retryable 4xx: the caller decides what it means
      }
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) {
      await politeDelay(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0);
    }
  }
  throw new Error(`fetch ${url} failed after ${attempts} attempts: ${lastProblem}`);
}
