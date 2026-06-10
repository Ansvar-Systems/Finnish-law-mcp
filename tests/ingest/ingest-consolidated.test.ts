/**
 * Acquisition repair tests (issue #78): the ingest must serve the CURRENT
 * consolidation (statute-consolidated/{y}/{n}/fin@latest), never pin to the
 * original as-enacted expression (statute/{y}/{n}/fin@ = alkup).
 *
 * Oracle (real upstream data, captured 2026-06-10): Tietosuojalaki 1050/2018
 * consolidation 20260380 contains §18a (inserted by 902/2020) and the
 * 808/2019-based §25 — none of which exist in the as-enacted text the old
 * pipeline fetched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseFinlexXml, ingestFinlexStatute } from '../../scripts/ingest-finlex.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/finlex');
const consolidatedFin = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2018-1050-fin-latest.xml'),
  'utf-8'
);
const consolidatedSwe = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2018-1050-swe-latest.xml'),
  'utf-8'
);
const originalFin = fs.readFileSync(path.join(FIXTURES, 'statute-2018-1050-fin-original.xml'), 'utf-8');

describe('parseFinlexXml on a consolidated (multipleVersions) document', () => {
  const parsed = parseFinlexXml(consolidatedFin, '1050/2018');

  it('extracts the inserted §18a (added by 902/2020, absent from the as-enacted text)', () => {
    const sec18a = parsed.provisions.find(p => p.section === '18 a');
    expect(sec18a).toBeDefined();
    expect(sec18a?.content).toContain('61 artiklassa');
  });

  it('extracts the amended §25 (808/2019 reference replaced the 586/1996 one)', () => {
    const sec25 = parsed.provisions.find(p => p.section === '25' && p.chapter === '4');
    expect(sec25).toBeDefined();
    expect(sec25?.content).toContain('808/2019');
    expect(sec25?.content).not.toContain('586/1996');
  });

  it('keeps every original section plus both inserted ones (38 + §18a + §36a = 40, no duplicates)', () => {
    expect(parsed.provisions).toHaveLength(40);
    const sec36a = parsed.provisions.find(p => p.section === '36 a');
    expect(sec36a).toBeDefined(); // inserted by 380/2026 — the newest amendment
    const refs = parsed.provisions.map(p => `${p.chapter ?? ''}:${p.section}`);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('ingestFinlexStatute (offline, injected fetch)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finlex-ingest-test-'));
  });

  function makeFetch(routes: Record<string, { status: number; body?: string }>): typeof fetch {
    return (async (url: unknown) => {
      const u = String(url);
      for (const [needle, r] of Object.entries(routes)) {
        if (u.includes(needle)) {
          return new Response(r.body ?? 'not found', { status: r.status });
        }
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    }) as typeof fetch;
  }

  it('acquires the newest consolidation and stamps the version identity', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      delayMs: 0,
      cacheDir: path.join(tmpDir, 'cache'),
    });

    expect(outcome.written).toBe(true);
    expect(outcome.consolidationAbsent).toBe(false);

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    // url is the version-PINNED expression, never an ambiguous-version URL
    expect(seed.url).toBe(
      'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/2018/1050/fin@20260380'
    );
    expect(seed._ingest.doc_type).toBe('statute-consolidated');
    expect(seed._ingest.consolidation_version).toBe('20260380');
    expect(seed._ingest.consolidated_to).toBe('2026-05-22');
    expect(seed._ingest.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(seed._ingest.languages.fin.consolidation_version).toBe('20260380');
    expect(seed._ingest.languages.swe.consolidation_version).toBe('20260380');

    // The amendment content is in the seed (the staleness oracle)
    const sec18a = seed.provisions.find((p: { section: string }) => p.section === '18 a');
    expect(sec18a).toBeDefined();
    // Amendment provenance captured from finlex:originalVersionLabel
    expect(sec18a.metadata.amended_by).toBe('27.11.2020/902');
  });

  it('falls back to the original ONLY on a definitive consolidated 404, loudly stamped', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 404 },
        'statute-consolidated/2018/1050/swe@latest': { status: 404 },
        'statute/2018/1050/fin@': { status: 200, body: originalFin },
        'statute/2018/1050/swe@': { status: 404 },
      }),
      delayMs: 0,
      cacheDir: path.join(tmpDir, 'cache'),
    });

    expect(outcome.consolidationAbsent).toBe(true);
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed._ingest.doc_type).toBe('statute');
    expect(seed._ingest.consolidation_version).toBeNull();
    expect(seed.url).toBe(
      'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/2018/1050/fin@'
    );
  });

  it('THROWS when both consolidated and original are gone — never writes a hollow seed', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    await expect(
      ingestFinlexStatute('1050/2018', seedPath, {
        fetchImpl: makeFetch({
          'statute-consolidated/2018/1050/fin@latest': { status: 404 },
          'statute/2018/1050/fin@': { status: 404 },
        }),
        delayMs: 0,
        cacheDir: path.join(tmpDir, 'cache'),
      })
    ).rejects.toThrow(/404|not found/iu);
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it('propagates transient failures instead of treating them as gone', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    await expect(
      ingestFinlexStatute('1050/2018', seedPath, {
        fetchImpl: makeFetch({
          'statute-consolidated/2018/1050/fin@latest': { status: 503 },
        }),
        delayMs: 0,
        cacheDir: path.join(tmpDir, 'cache'),
        retryBackoffMs: [0, 0, 0],
      })
    ).rejects.toThrow(/503/u);
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it('skips the rewrite when the stamped version matches upstream (skip_current)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const opts = {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      delayMs: 0,
      cacheDir: path.join(tmpDir, 'cache'),
    };
    await ingestFinlexStatute('1050/2018', seedPath, opts);
    const firstWrite = fs.readFileSync(seedPath, 'utf-8');

    const second = await ingestFinlexStatute('1050/2018', seedPath, {
      ...opts,
      existingStampedVersion: '20260380',
    });
    expect(second.written).toBe(false);
    expect(second.decision).toBe('skip_current');
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(firstWrite);
  });

  it('omits Swedish text when the Swedish consolidation is at a DIFFERENT version (no silently mixed versions)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const mismatchedSwe = consolidatedSwe
      .replace(/20260380/gu, '20230239')
      .replace(/2026-05-22/gu, '2023-02-16');
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: mismatchedSwe },
      }),
      delayMs: 0,
      cacheDir: path.join(tmpDir, 'cache'),
    });

    expect(outcome.swedish).toBe('omitted_version_mismatch');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(JSON.stringify(seed.provisions)).not.toContain('content_sv');
    expect(seed._ingest.languages.swe).toBeUndefined();
  });
});
