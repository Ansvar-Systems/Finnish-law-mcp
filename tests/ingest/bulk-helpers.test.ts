/**
 * Bulk-sweep operability tests (PR #79 round-2):
 *  - transport-outage abort: only HTTP 429 aborted the sweep; a sustained
 *    network outage burned every remaining candidate at ~16s each (observed
 *    live: 269 consecutive transport failures, ~75-90 min wasted).
 *  - durable run-stamped reports: the report was written ONLY after loop
 *    completion to a fixed overwritten filename — a killed sweep left no
 *    record at all (Dutch round-2 lesson: run-stamped report files).
 *  - the refresh contract (`npm run ingest:refresh`) must walk the EXISTING
 *    corpus (--seeds-only): list-driven refresh silently expands the corpus
 *    and reuses a stale cached catalogue.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyIngestFailure,
  runReportPath,
  TRANSPORT_ABORT_THRESHOLD,
} from '../../scripts/ingest-finlex-bulk.js';

describe('classifyIngestFailure', () => {
  it('recognizes rate limiting (429) — aborts immediately as before', () => {
    expect(classifyIngestFailure('HTTP 429 from Finlex list endpoint')).toBe('rate_limited');
    expect(
      classifyIngestFailure('fetch https://x failed after 4 attempts: HTTP 429')
    ).toBe('rate_limited');
  });

  it('recognizes exhausted-retry transport failures (network outage / persistent 5xx)', () => {
    expect(
      classifyIngestFailure('fetch https://opendata.finlex.fi/... failed after 4 attempts: fetch failed')
    ).toBe('transport');
    expect(
      classifyIngestFailure('fetch https://opendata.finlex.fi/... failed after 4 attempts: HTTP 503')
    ).toBe('transport');
  });

  it('leaves per-document failures (parse errors, identity mismatches, zero provisions) as other', () => {
    expect(classifyIngestFailure('Body identity mismatch for X')).toBe('other');
    expect(classifyIngestFailure('document parsed to ZERO provisions')).toBe('other');
  });

  it('exposes a sane consecutive-failure threshold', () => {
    expect(TRANSPORT_ABORT_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(TRANSPORT_ABORT_THRESHOLD).toBeLessThanOrEqual(10);
  });
});

describe('runReportPath (durable run-stamped reports)', () => {
  it('derives a per-run filename from the start timestamp (no fixed-name overwrites)', () => {
    const p = runReportPath('2026-06-11T03:00:00.123Z');
    expect(path.basename(p)).toBe('finlex-bulk-run-2026-06-11T03-00-00Z.json');
    expect(p).toContain(`reports${path.sep}ingest`);
  });

  it('two runs get two distinct report files', () => {
    expect(runReportPath('2026-06-11T03:00:00.000Z')).not.toBe(runReportPath('2026-06-11T04:30:01.000Z'));
  });
});

describe('refresh contract', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  it('npm run ingest:refresh walks the existing corpus (--refresh AND --seeds-only)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['ingest:refresh']).toContain('--refresh');
    expect(pkg.scripts['ingest:refresh']).toContain('--seeds-only');
  });

  it('gitignores the forensic source-cache and run-stamped reports', () => {
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('data/source-cache/');
    expect(gitignore).toContain('reports/ingest/finlex-bulk-run-');
  });
});
