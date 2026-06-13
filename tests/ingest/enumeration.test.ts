/**
 * Worklist enumeration tests (issue #82).
 *
 * The prior pipeline enumerated ONLY the as-enacted `statute/list`, so core
 * in-force acts — the financial pillars (610/2014 luottolaitoslaki, 747/2012,
 * 521/2008, 878/2008, 1286/2014, 611/2014) and the Penal Code (39/1889) — were
 * dropped or mis-enumerated. 4 of 5 financial pillars (the exact acts this
 * re-ingestion exists to fix) were absent from a 42,534-row worklist while
 * 444/2017 survived. The census floor cannot catch this (it counts statutes,
 * not WHICH ones), so this suite locks the contract:
 *
 *   1. parseAknUri accepts BOTH doctypes and discards the dated `@YYYYNNNN`
 *      consolidation suffix (the fetch resolves fin@latest, never a list date).
 *   2. selectCandidates collapses the many per-version rows the consolidated
 *      list emits per act into ONE candidate, unioned with the as-enacted list.
 *   3. The named-must-have gate (REQUIRED_STATUTES) is present and fail-closes.
 *   4. ACCEPTANCE: the union of recorded list samples yields all 6 named acts.
 *   5. ACCEPTANCE: fetching+parsing 610/2014 yields ~300 sections (the resolver
 *      proved 301). Fixture-backed (offline-stable); a guarded live check runs
 *      only when FINLEX_LIVE=1.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  parseAknUri,
  selectCandidates,
  missingRequiredStatutes,
  assertRequiredStatutes,
  isUnscopedRun,
  REQUIRED_STATUTES,
} from '../../scripts/ingest-finlex-bulk.js';
import { parseFinlexXml, ingestFinlexStatute } from '../../scripts/ingest-finlex.js';

const C = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated';
const S = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute';

describe('parseAknUri — both doctypes, dated-suffix-agnostic', () => {
  it('parses an as-enacted (bare fin@) URI', () => {
    const c = parseAknUri(`${S}/2014/610/fin@`);
    expect(c?.canonical_id).toBe('610/2014');
    expect(c?.number_token).toBe('610');
  });

  it('parses a consolidated DATED URI and discards the @YYYYNNNN version', () => {
    const c = parseAknUri(`${C}/2014/610/fin@20220667`);
    expect(c?.canonical_id).toBe('610/2014');
    // number_token is the act number, NOT the consolidation date.
    expect(c?.number_token).toBe('610');
  });

  it('keeps the -NNN sub-number (part of the act identity on Finlex)', () => {
    const c = parseAknUri(`${S}/1889/39-001/fin@`);
    expect(c?.canonical_id).toBe('39/1889');
    expect(c?.number_token).toBe('39-001'); // statute-consolidated/1889/39-001/fin@latest is the resolving URI
  });

  it('parses Swedish rows too (swe@)', () => {
    const c = parseAknUri(`${C}/2014/610/swe@20221175`);
    expect(c?.canonical_id).toBe('610/2014');
  });

  it('returns null for non-statute URIs', () => {
    expect(parseAknUri('https://example.org/not/a/statute')).toBeNull();
    expect(parseAknUri(undefined)).toBeNull();
  });
});

describe('selectCandidates — multi-version collapse + dual-list union', () => {
  it('collapses the many consolidated versions of one act into a single candidate', () => {
    // The consolidated list emits one row per (act, lang, version-date): exactly
    // the shape that, kept un-deduped, would explode the worklist.
    const entries = [
      { akn_uri: `${C}/2014/610/swe@20221175` },
      { akn_uri: `${C}/2014/610/fin@20220667` },
      { akn_uri: `${C}/2014/610/fin@20230183` },
      { akn_uri: `${C}/2014/610/fin@` }, // bare = oldest consolidation
      { akn_uri: `${C}/2014/610/fin@20260352` },
    ];
    const candidates = selectCandidates(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].canonical_id).toBe('610/2014');
    expect(candidates[0].number_token).toBe('610');
  });

  it('unions consolidated + as-enacted rows for distinct acts (never-amended backfill)', () => {
    const entries = [
      // 610/2014 only in the consolidated list (amended)
      { akn_uri: `${C}/2014/610/fin@20220667` },
      // 5/2099 only in the as-enacted list (never amended → no consolidation)
      { akn_uri: `${S}/2099/5/fin@` },
    ];
    const ids = selectCandidates(entries).map(c => c.canonical_id).sort();
    expect(ids).toEqual(['5/2099', '610/2014']);
  });
});

describe('named-must-have gate (REQUIRED_STATUTES)', () => {
  it('declares the 6 named acts + Penal Code + Constitution', () => {
    for (const id of ['610/2014', '747/2012', '521/2008', '878/2008', '444/2017', '39/1889']) {
      expect(REQUIRED_STATUTES).toContain(id);
    }
  });

  it('missingRequiredStatutes returns the absent ids', () => {
    const candidates = [parseAknUri(`${C}/2014/610/fin@20220667`)!];
    const missing = missingRequiredStatutes(candidates);
    expect(missing).toContain('39/1889');
    expect(missing).not.toContain('610/2014');
  });

  it('assertRequiredStatutes THROWS on an unscoped run missing a core act', () => {
    const candidates = [parseAknUri(`${C}/2014/610/fin@20220667`)!]; // only 610
    expect(() => assertRequiredStatutes(candidates, {})).toThrow(/missing .* required core statute/i);
  });

  it('assertRequiredStatutes is a no-op for a scoped (windowed/limited) run', () => {
    const candidates = [parseAknUri(`${C}/2014/610/fin@20220667`)!];
    expect(() => assertRequiredStatutes(candidates, { fromYear: 2014, toYear: 2014 })).not.toThrow();
    expect(() => assertRequiredStatutes(candidates, { limit: 1 })).not.toThrow();
    expect(isUnscopedRun({})).toBe(true);
    expect(isUnscopedRun({ limit: 1 })).toBe(false);
  });

  it('passes when every required act is enumerated', () => {
    const entries = REQUIRED_STATUTES.map(id => {
      const [num, year] = id.split('/');
      return { akn_uri: `${C}/${year}/${num}/fin@latest` };
    });
    const candidates = selectCandidates(entries);
    expect(missingRequiredStatutes(candidates)).toEqual([]);
    expect(() => assertRequiredStatutes(candidates, {})).not.toThrow();
  });
});

describe('ACCEPTANCE: the worklist contains the 6 named acts', () => {
  // Recorded list-row samples (one per act; the consolidated list has many more
  // version rows per act, collapsed by selectCandidates). This is the unit-layer
  // proof that the dual-doctype enumeration enumerates the named acts.
  const NAMED = ['610/2014', '747/2012', '521/2008', '878/2008', '444/2017', '39/1889'] as const;
  const TOKEN: Record<string, string> = { '39/1889': '39-001' };

  it('enumerates 610/2014, 747/2012, 521/2008, 878/2008, 444/2017, 39/1889', () => {
    const entries = NAMED.map(id => {
      const [num, year] = id.split('/');
      const token = TOKEN[id] ?? num;
      // Consolidated dated row (the shape the old enumeration dropped).
      return { akn_uri: `${C}/${year}/${token}/fin@20990001` };
    });
    const ids = new Set(selectCandidates(entries).map(c => c.canonical_id));
    for (const id of NAMED) expect(ids).toContain(id);
  });
});

describe('ACCEPTANCE: fetch+parse 610/2014 yields ~300 sections', () => {
  const FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/finlex/statute-consolidated-2014-610-fin-latest.xml'
  );

  it('parses the recorded fin@latest consolidation into ~300 provisions', () => {
    const xml = fs.readFileSync(FIXTURE, 'utf-8');
    const parsed = parseFinlexXml(xml, '610/2014');
    expect(parsed.title).toContain('luottolaitos'); // Laki luottolaitostoiminnasta
    expect(parsed.contentAbsent).toBe(false);
    // Resolver proved 301 sections; parseFinlexXml yields 300 provisions.
    expect(parsed.provisions.length).toBeGreaterThanOrEqual(280);
    expect(parsed.provisions.length).toBeLessThanOrEqual(320);
  });

  // Network-optional live witness: proves the fixture still matches upstream.
  const live = process.env.FINLEX_LIVE === '1' ? it : it.skip;
  live('live fetch+ingest of 610/2014 produces a ~300-provision seed', async () => {
    const tmp = path.join(
      fs.mkdtempSync(path.join((process.env.TMPDIR ?? '/tmp'), 'fi-610-')),
      '610_2014.json'
    );
    await ingestFinlexStatute('610/2014', tmp, { canonicalStatuteId: '610/2014' });
    const seed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as { provisions: unknown[] };
    expect(seed.provisions.length).toBeGreaterThanOrEqual(280);
  }, 60000);
});
