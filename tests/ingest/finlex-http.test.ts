/**
 * Transient-vs-gone HTTP discipline (issue #78, port of dutch-law-mcp http-retry).
 *
 * Transient failures (5xx, 429, network throw) retry then THROW — they may
 * never be soft-failed into "document gone upstream". 404 is returned to the
 * caller: a 404 on statute-consolidated IS a finding (no consolidation
 * published), not an error.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../../scripts/lib/finlex-http.js';

const NO_BACKOFF = { backoffMs: [0, 0, 0] };

function response(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('fetchWithRetry', () => {
  it('returns an ok response directly', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<xml/>'));
    const res = await fetchWithRetry('https://x/y', { fetchImpl, ...NO_BACKOFF });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns 404 to the caller without retrying — gone is a finding', async () => {
    const fetchImpl = vi.fn(async () => response(404));
    const res = await fetchWithRetry('https://x/y', { fetchImpl, ...NO_BACKOFF });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn<Parameters<typeof fetch>, Promise<Response>>()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, 'ok'));
    const res = await fetchWithRetry('https://x/y', { fetchImpl, ...NO_BACKOFF });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries 429 (rate limit) then succeeds', async () => {
    const fetchImpl = vi
      .fn<Parameters<typeof fetch>, Promise<Response>>()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, 'ok'));
    const res = await fetchWithRetry('https://x/y', { fetchImpl, ...NO_BACKOFF });
    expect(res.status).toBe(200);
  });

  it('THROWS after exhausting attempts on persistent 5xx — never soft-fails to gone', async () => {
    const fetchImpl = vi.fn(async () => response(502));
    await expect(
      fetchWithRetry('https://x/y', { fetchImpl, attempts: 3, ...NO_BACKOFF })
    ).rejects.toThrow(/502/u);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('THROWS after exhausting attempts on network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      fetchWithRetry('https://x/y', { fetchImpl, attempts: 2, ...NO_BACKOFF })
    ).rejects.toThrow(/ECONNRESET/u);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes headers through (Finlex requires User-Agent)', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/Finnish-Law-MCP/u);
      return response(200);
    });
    await fetchWithRetry('https://x/y', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { 'User-Agent': 'Finnish-Law-MCP/test' },
      ...NO_BACKOFF,
    });
  });
});
