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
const repealedFin = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-1999-523-fin-latest.xml'),
  'utf-8'
);
const contentAbsentShell = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2005-45-fin-contentabsent.xml'),
  'utf-8'
);
const original45 = fs.readFileSync(path.join(FIXTURES, 'statute-2005-45-fin-original.xml'), 'utf-8');

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

  function baseOpts(): { delayMs: number; cacheDir: string; forensicCacheDir: string } {
    return {
      delayMs: 0,
      cacheDir: path.join(tmpDir, 'cache'),
      forensicCacheDir: path.join(tmpDir, 'forensic'),
    };
  }

  it('acquires the newest consolidation and stamps the version identity', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      ...baseOpts(),
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

    // Status is a FACT from finlex lifecycle metadata, never a constant.
    expect(seed.status).toBe('in_force');
    expect(seed._ingest.status_basis).toBe('finlex_lifecycle_metadata');
    expect(seed._ingest.lifecycle.is_in_force).toBe(true);
    // in_force_date from finlex:dateEntryIntoForce, not the enactment date.
    expect(seed.in_force_date).toBe('2019-01-01');

    // provision_versions claim validity from the CONSOLIDATION's date, not the
    // original enactment date (an inserted §18a did not exist in 2018).
    expect(seed.provision_versions[0].valid_from).toBe('2026-05-22');

    // Forensic copies live OUTSIDE the immutable original cache.
    const cacheDir = path.join(tmpDir, 'cache');
    const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
    expect(cacheFiles.filter(f => f.includes('@'))).toEqual([]);
    const forensic = fs.readdirSync(path.join(tmpDir, 'forensic'));
    expect(forensic).toContain('2018_1050_fin@20260380.consolidated.xml');
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
      ...baseOpts(),
    });

    expect(outcome.consolidationAbsent).toBe(true);
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed._ingest.doc_type).toBe('statute');
    expect(seed._ingest.consolidation_version).toBeNull();
    expect(seed.url).toBe(
      'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/2018/1050/fin@'
    );
    // As-enacted originals carry NO lifecycle metadata upstream: the status is
    // the documented corpus default, stamped as unverified — auditable, never
    // disguised as a proven fact.
    expect(seed.status).toBe('in_force');
    expect(seed._ingest.status_basis).toBe('as_enacted_default_unverified');
    // As-enacted text: validity claimed from enactment, the only date upstream proves.
    expect(seed.provision_versions[0].valid_from).toBe('2018-12-05');
  });

  it('stamps repealed acts as repealed from finlex lifecycle metadata (523/1999, repealed by 1050/2018)', async () => {
    const seedPath = path.join(tmpDir, '523_1999.json');
    await ingestFinlexStatute('523/1999', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/1999/523/fin@latest': { status: 200, body: repealedFin },
        'statute-consolidated/1999/523/swe@latest': { status: 404 },
      }),
      ...baseOpts(),
    });

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed.status).toBe('repealed');
    expect(seed._ingest.status_basis).toBe('finlex_lifecycle_metadata');
    expect(seed._ingest.lifecycle.is_in_force).toBe(false);
    expect(seed._ingest.lifecycle.date_in_force_end).toBe('2018-12-31');
    expect(seed._ingest.lifecycle.repealed_by).toEqual(['1050/2018']);
  });

  it('THROWS when both consolidated and original are gone — never writes a hollow seed', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    await expect(
      ingestFinlexStatute('1050/2018', seedPath, {
        fetchImpl: makeFetch({
          'statute-consolidated/2018/1050/fin@latest': { status: 404 },
          'statute/2018/1050/fin@': { status: 404 },
        }),
        ...baseOpts(),
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
        ...baseOpts(),
        retryBackoffMs: [0, 0, 0],
      })
    ).rejects.toThrow(/503/u);
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it('skips the rewrite when BOTH stamped language versions match upstream (skip_current, no Swedish probe)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const opts = {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      ...baseOpts(),
    };
    await ingestFinlexStatute('1050/2018', seedPath, opts);
    const firstWrite = fs.readFileSync(seedPath, 'utf-8');

    const second = await ingestFinlexStatute('1050/2018', seedPath, {
      // Routes deliberately limited to the FINNISH probe: a skip must not
      // touch the Swedish endpoint (makeFetch throws on unexpected URLs).
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
      }),
      ...baseOpts(),
      existingStampedVersion: '20260380',
      existingStampedSwedishVersion: '20260380',
    });
    expect(second.written).toBe(false);
    expect(second.decision).toBe('skip_current');
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(firstWrite);
  });

  it('does NOT skip when the Finnish version matches but Swedish was previously omitted (the parked-forever hole)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    // Seed written earlier with Swedish omitted: stamped fin=20260380, no swe.
    fs.writeFileSync(seedPath, JSON.stringify({ id: '1050/2018', provisions: [{ provision_ref: '1:1', section: '1', content: 'x' }] }), 'utf-8');

    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      ...baseOpts(),
      existingStampedVersion: '20260380',
      existingStampedSwedishVersion: null,
    });

    // The Swedish consolidation has caught up — the seed must be completed.
    expect(outcome.decision).not.toBe('skip_current');
    expect(outcome.swedish).toBe('consolidated');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed._ingest.languages.swe.consolidation_version).toBe('20260380');
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
      ...baseOpts(),
    });

    expect(outcome.swedish).toBe('omitted_version_mismatch');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(JSON.stringify(seed.provisions)).not.toContain('content_sv');
    expect(seed._ingest.languages.swe).toBeUndefined();
  });

  it('falls back EXPLICITLY (stamped) to the original when the consolidation is an empty contentAbsent shell', async () => {
    const seedPath = path.join(tmpDir, '45_2005.json');
    const outcome = await ingestFinlexStatute('45/2005', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2005/45/fin@latest': { status: 200, body: contentAbsentShell },
        'statute/2005/45/fin@': { status: 200, body: original45 },
        'statute/2005/45/swe@': { status: 404 },
      }),
      ...baseOpts(),
    });

    expect(outcome.contentAbsentFallback).toBe(true);
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    // Real text from the as-enacted original — never a hollow seed.
    expect(seed.provisions.length).toBeGreaterThan(0);
    expect(seed._ingest.doc_type).toBe('statute');
    expect(seed.url).toContain('/act/statute/2005/45/fin@');
    // The shell's existence and version are stamped, not erased.
    expect(seed._ingest.consolidated_content_absent).toEqual({
      version: '20050045',
      consolidated_to: '2005-01-28',
    });
    // Status comes from the SHELL's lifecycle metadata (authoritative even
    // when the body is absent): 45/2005 is in force per finlex:isInForce.
    expect(seed.status).toBe('in_force');
    expect(seed._ingest.status_basis).toBe('finlex_lifecycle_metadata');
    expect(seed.in_force_date).toBe('2005-10-05');
  });

  it('FAILS LOUD when a document parses to zero provisions without a recognized contentAbsent marker', async () => {
    const seedPath = path.join(tmpDir, '45_2005.json');
    const unknownShape = contentAbsentShell.replace(
      '<hcontainer name="contentAbsent"/>',
      '<p>unrecognized body shape</p>'
    );
    await expect(
      ingestFinlexStatute('45/2005', seedPath, {
        fetchImpl: makeFetch({
          'statute-consolidated/2005/45/fin@latest': { status: 200, body: unknownShape },
        }),
        ...baseOpts(),
      })
    ).rejects.toThrow(/zero provisions/iu);
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it('NEVER overwrites a seed holding real content when the shell fallback has nothing to offer', async () => {
    const seedPath = path.join(tmpDir, '45_2005.json');
    const realContent = JSON.stringify({
      id: '45/2005',
      provisions: [{ provision_ref: '1', section: '1', content: 'real statute text' }],
    });
    fs.writeFileSync(seedPath, realContent, 'utf-8');

    await expect(
      ingestFinlexStatute('45/2005', seedPath, {
        fetchImpl: makeFetch({
          'statute-consolidated/2005/45/fin@latest': { status: 200, body: contentAbsentShell },
          'statute/2005/45/fin@': { status: 404 },
        }),
        ...baseOpts(),
      })
    ).rejects.toThrow();
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(realContent);
  });

  it('retries a 404 on a PREVIOUSLY-consolidated statute and proceeds when it was transient', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    fs.writeFileSync(seedPath, '{"id":"1050/2018","provisions":[{"section":"1","content":"old"}]}', 'utf-8');
    let finCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('statute-consolidated/2018/1050/fin@latest')) {
        finCalls += 1;
        return finCalls === 1
          ? new Response('not found', { status: 404 })
          : new Response(consolidatedFin, { status: 200 });
      }
      if (u.includes('statute-consolidated/2018/1050/swe@latest')) {
        return new Response(consolidatedSwe, { status: 200 });
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    }) as typeof fetch;

    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl,
      ...baseOpts(),
      existingStampedVersion: '20230239',
    });
    expect(finCalls).toBe(2);
    expect(outcome.consolidationAbsent).toBe(false);
    expect(outcome.decision).toBe('refetch_changed');
  });

  it('treats a PERSISTENT 404 on a previously-consolidated statute as a loud anomaly, never a silent downgrade', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const before = '{"id":"1050/2018","provisions":[{"section":"1","content":"consolidated text"}]}';
    fs.writeFileSync(seedPath, before, 'utf-8');
    let finCalls = 0;
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('statute-consolidated/2018/1050/fin@latest')) {
        finCalls += 1;
        return new Response('not found', { status: 404 });
      }
      // The as-enacted original IS available — the old code silently downgraded to it.
      if (u.includes('statute/2018/1050/fin@')) {
        return new Response(originalFin, { status: 200 });
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    }) as typeof fetch;

    await expect(
      ingestFinlexStatute('1050/2018', seedPath, {
        fetchImpl,
        ...baseOpts(),
        existingStampedVersion: '20230239',
      })
    ).rejects.toThrow(/disappear|downgrade|anomal/iu);
    expect(finCalls).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(before);
  });

  it('keeps the newer seed when upstream serves an OLDER consolidation than the stamp (stale_upstream)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const before = '{"id":"1050/2018","provisions":[{"section":"1","content":"newer text"}]}';
    fs.writeFileSync(seedPath, before, 'utf-8');

    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
      }),
      ...baseOpts(),
      existingStampedVersion: '20270001', // stamp PROVES a newer consolidation was served before
    });

    expect(outcome.decision).toBe('stale_upstream');
    expect(outcome.written).toBe(false);
    expect(fs.readFileSync(seedPath, 'utf-8')).toBe(before);
  });

  it('REJECTS a served body whose identity does not match the requested statute (redirect surprises)', async () => {
    const seedPath = path.join(tmpDir, '999_2018.json');
    await expect(
      ingestFinlexStatute('999/2018', seedPath, {
        fetchImpl: makeFetch({
          // Upstream serves the 1050/2018 document for the 999/2018 request.
          'statute-consolidated/2018/999/fin@latest': { status: 200, body: consolidatedFin },
        }),
        ...baseOpts(),
      })
    ).rejects.toThrow(/identity|mismatch/iu);
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it('self-heals a corrupt original-XML cache file instead of failing forever (sticky-cache fix)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // A truncated/corrupt cache file from an interrupted earlier run.
    fs.writeFileSync(path.join(cacheDir, '2018_1050_fin.xml'), '<akomaNtoso><act><met', 'utf-8');

    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 404 },
        'statute-consolidated/2018/1050/swe@latest': { status: 404 },
        'statute/2018/1050/fin@': { status: 200, body: originalFin },
        'statute/2018/1050/swe@': { status: 404 },
      }),
      ...baseOpts(),
    });

    expect(outcome.consolidationAbsent).toBe(true);
    expect(fs.existsSync(seedPath)).toBe(true);
    // The corrupt cache entry was replaced by the refetched valid document.
    expect(fs.readFileSync(path.join(cacheDir, '2018_1050_fin.xml'), 'utf-8')).toContain('<identification');
  });

  it('prunes superseded forensic copies (keep only the version just fetched)', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const forensicDir = path.join(tmpDir, 'forensic');
    fs.mkdirSync(forensicDir, { recursive: true });
    fs.writeFileSync(path.join(forensicDir, '2018_1050_fin@20230239.consolidated.xml'), '<old/>', 'utf-8');

    await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeFetch({
        'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
        'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
      }),
      ...baseOpts(),
    });

    const copies = fs.readdirSync(forensicDir).filter(f => f.startsWith('2018_1050_fin@'));
    expect(copies).toEqual(['2018_1050_fin@20260380.consolidated.xml']);
  });
});

describe('round-3 hardening (PR #79 delta review)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finlex-r3-test-'));
  });
  function makeCountingFetch(
    routes: Record<string, { status: number; body?: string } | Array<{ status: number; body?: string }>>,
    counts: Map<string, number>,
  ): typeof fetch {
    return (async (url: unknown) => {
      const u = String(url);
      for (const [needle, r] of Object.entries(routes)) {
        if (u.includes(needle)) {
          const n = (counts.get(needle) ?? 0) + 1;
          counts.set(needle, n);
          const resp = Array.isArray(r) ? r[Math.min(n - 1, r.length - 1)] : r;
          return new Response(resp.body ?? 'not found', { status: resp.status });
        }
      }
      throw new Error(`Unexpected URL in test: ${u}`);
    }) as typeof fetch;
  }
  const opts = () => ({
    delayMs: 0,
    cacheDir: path.join(tmpDir, 'cache'),
    forensicCacheDir: path.join(tmpDir, 'forensic'),
  });

  it('F1: zero-provision Swedish text is never stamped consolidated', async () => {
    // Swedish responds with the contentAbsent shell at the MATCHING version:
    // version equality alone must not stamp swedish='consolidated'.
    const sweShell = contentAbsentShell
      .replace(/2005\/45/gu, '2018/1050')
      .replace(/20050045/gu, '20260380')
      .replace(/45\/2005/gu, '1050/2018');
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const counts = new Map<string, number>();
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeCountingFetch(
        {
          'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin },
          'statute-consolidated/2018/1050/swe@latest': { status: 200, body: sweShell },
        },
        counts,
      ),
      ...opts(),
    });
    expect(outcome.written).toBe(true);
    expect(outcome.swedish).toBe('omitted_content_absent');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    // No Swedish stamp => the both-languages skip_current can never treat
    // this seed as bilingual-complete.
    expect(seed._ingest.languages.swe).toBeUndefined();
  });

  it('F2a: the stamp is read from the existing seed when the caller does not supply it', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    fs.writeFileSync(
      seedPath,
      JSON.stringify({ id: '1050/2018', _ingest: { doc_type: 'statute-consolidated', consolidation_version: '20260380' } }),
    );
    const counts = new Map<string, number>();
    // Persistent 404 on the consolidated expression: the on-disk stamp proves
    // a consolidation existed -> loud anomaly, NEVER a silent downgrade.
    await expect(
      ingestFinlexStatute('1050/2018', seedPath, {
        fetchImpl: makeCountingFetch(
          { 'statute-consolidated/2018/1050/fin@latest': { status: 404 } },
          counts,
        ),
        ...opts(),
      }),
    ).rejects.toThrow(/DISAPPEARED|anomaly/iu);
  });

  it('F2b: a first 404 on the consolidated expression gets one confirming probe even with no stamp', async () => {
    const seedPath = path.join(tmpDir, '1050_2018.json');
    const counts = new Map<string, number>();
    const outcome = await ingestFinlexStatute('1050/2018', seedPath, {
      fetchImpl: makeCountingFetch(
        {
          // transient 404, then the real consolidation on the confirm probe
          'statute-consolidated/2018/1050/fin@latest': [
            { status: 404 },
            { status: 200, body: consolidatedFin },
          ],
          'statute-consolidated/2018/1050/swe@latest': { status: 200, body: consolidatedSwe },
        },
        counts,
      ),
      ...opts(),
    });
    expect(counts.get('statute-consolidated/2018/1050/fin@latest')).toBe(2);
    expect(outcome.consolidationAbsent).toBe(false);
  });

  it('F3: a body-torn as-enacted cache file is discarded and refetched', async () => {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Head intact (identification parses), body torn at 60%.
    const torn = original45.slice(0, Math.floor(original45.length * 0.6));
    fs.writeFileSync(path.join(cacheDir, '2005_45_fin.xml'), torn);
    const counts = new Map<string, number>();
    const outcome = await ingestFinlexStatute('45/2005', path.join(tmpDir, '45_2005.json'), {
      fetchImpl: makeCountingFetch(
        {
          'statute-consolidated/2005/45/fin@latest': { status: 200, body: contentAbsentShell },
          'statute/2005/45/fin@': { status: 200, body: original45 },
          'statute-consolidated/2005/45/swe@latest': { status: 404 },
          'statute/2005/45/swe@': { status: 404 },
        },
        counts,
      ),
      ...opts(),
    });
    expect(outcome.written).toBe(true);
    // The torn cache must NOT have been trusted: the as-enacted expression
    // was refetched over the network.
    expect(counts.get('statute/2005/45/fin@')).toBeGreaterThanOrEqual(1);
  });

  it('F4: the forensic prune keeps the NEWEST version, not the just-fetched one', async () => {
    const forensic = path.join(tmpDir, 'forensic');
    fs.mkdirSync(forensic, { recursive: true });
    // A NEWER forensic copy exists (the XML the kept seed was built from).
    fs.writeFileSync(path.join(forensic, '2018_1050_fin@20270001.consolidated.xml'), '<newer/>');
    const seedPath = path.join(tmpDir, '1050_2018.json');
    fs.writeFileSync(seedPath, JSON.stringify({ id: '1050/2018' }));
    const counts = new Map<string, number>();
    // Upstream serves the OLDER 20260380 while the stamp says 20270001:
    // stale_upstream path — the newer audit copy must survive.
    await ingestFinlexStatute('1050/2018', seedPath, {
      existingStampedVersion: '20270001',
      fetchImpl: makeCountingFetch(
        { 'statute-consolidated/2018/1050/fin@latest': { status: 200, body: consolidatedFin } },
        counts,
      ),
      ...opts(),
    });
    expect(fs.existsSync(path.join(forensic, '2018_1050_fin@20270001.consolidated.xml'))).toBe(true);
  });

  it('F7: repealed statutes carry the repeal date in the description (build-db extractor convention)', async () => {
    const seedPath = path.join(tmpDir, '523_1999.json');
    const counts = new Map<string, number>();
    await ingestFinlexStatute('523/1999', seedPath, {
      fetchImpl: makeCountingFetch(
        {
          'statute-consolidated/1999/523/fin@latest': { status: 200, body: repealedFin },
          'statute-consolidated/1999/523/swe@latest': { status: 404 },
          'statute/1999/523/swe@': { status: 404 },
        },
        counts,
      ),
      ...opts(),
    });
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    expect(seed.status).toBe('repealed');
    expect(seed.description).toMatch(/Kumottu \d{4}-\d{2}-\d{2}/u);
  });
});

describe('contentAbsent detection is structural (round 3, F8)', () => {
  it('does not flag a document whose marker sits outside an otherwise substantive body', () => {
    // A future shape gap that parses 0 provisions must FAIL LOUD, not slide
    // into the contentAbsent fallback because a marker matched anywhere.
    const xml = contentAbsentShell.replace(
      '<hcontainer name="contentAbsent"/>',
      '<unknownVocab>real text the extractor cannot read yet</unknownVocab>',
    ).replace('</meta>', '<note><hcontainer name="contentAbsent"/></note></meta>');
    const parsed = parseFinlexXml(xml, '45/2005');
    expect(parsed.contentAbsent).toBe(false);
  });
});
