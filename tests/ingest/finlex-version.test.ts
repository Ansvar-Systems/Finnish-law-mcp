/**
 * Version-identity + refresh-policy tests (issue #78, port of dutch-law-mcp#119 fix).
 *
 * Fixtures are REAL Finlex open-data responses captured 2026-06-10:
 *  - statute/2018/1050/fin@                       -> original as-enacted (alkup)
 *  - statute-consolidated/2018/1050/fin@latest    -> consolidation 20260380 (ajantasa 2026-05-22)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  parseVersionIdentity,
  assertCurrentConsolidation,
  compareVersionNumbers,
  decideFetch,
  decideRewrite,
  parseLifecycle,
  deriveSeedStatus,
  stampedLanguageVersionsOf,
  seedStampInfoOf,
} from '../../scripts/lib/finlex-version.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/finlex');

const consolidatedXml = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2018-1050-fin-latest.xml'),
  'utf-8'
);
const originalXml = fs.readFileSync(
  path.join(FIXTURES, 'statute-2018-1050-fin-original.xml'),
  'utf-8'
);
const repealedXml = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-1999-523-fin-latest.xml'),
  'utf-8'
);
const contentAbsentXml = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2005-45-fin-contentabsent.xml'),
  'utf-8'
);

describe('parseVersionIdentity', () => {
  it('extracts the consolidation identity from a statute-consolidated expression', () => {
    const id = parseVersionIdentity(consolidatedXml);
    expect(id.doc_type).toBe('statute-consolidated');
    expect(id.expression_uri).toBe('/akn/fi/act/statute-consolidated/2018/1050/fin@20260380');
    expect(id.version_number).toBe('20260380');
    expect(id.consolidated_to).toBe('2026-05-22');
    expect(id.eli_uri).toBe('http://data.finlex.fi/eli/sd/2018/1050/ajantasa/2026-05-22/fin');
    expect(id.language).toBe('fin');
    expect(id.contains).toBe('multipleVersions');
  });

  it('extracts the as-enacted identity from an original statute expression', () => {
    const id = parseVersionIdentity(originalXml);
    expect(id.doc_type).toBe('statute');
    expect(id.expression_uri).toBe('/akn/fi/act/statute/2018/1050/fin@');
    expect(id.version_number).toBeNull();
    expect(id.consolidated_to).toBeNull();
    expect(id.eli_uri).toBe('http://data.finlex.fi/eli/sd/2018/1050/alkup/fin');
    expect(id.contains).toBe('originalVersion');
  });

  it('fails loud on XML without an identification block', () => {
    expect(() => parseVersionIdentity('<akomaNtoso><act/></akomaNtoso>')).toThrow(/identification/iu);
  });

  it('pins a bare-@ consolidated FRBRuri with the FRBRversionNumber (single-version consolidations)', () => {
    // Upstream serves single-version consolidations with a BARE '@' FRBRuri —
    // the exact ambiguous form the module header forbids (re-resolves to the
    // OLDEST expression once a second version appears). The version number is
    // in the same identification block, so the identity must be pinned.
    const id = parseVersionIdentity(contentAbsentXml);
    expect(id.doc_type).toBe('statute-consolidated');
    expect(id.version_number).toBe('20050045');
    expect(id.expression_uri).toBe('/akn/fi/act/statute-consolidated/2005/45/fin@20050045');
  });
});

describe('parseLifecycle (finlex proprietary lifecycle metadata)', () => {
  it('reads in-force lifecycle from a current consolidation', () => {
    const lc = parseLifecycle(consolidatedXml);
    expect(lc.is_in_force).toBe(true);
    expect(lc.date_entry_into_force).toBe('2019-01-01');
    expect(lc.date_in_force_end).toBeNull();
    expect(lc.repealed_by).toEqual([]);
  });

  it('reads repealed lifecycle (isInForce=false + dateInForceEnd + repealedBy) — 523/1999', () => {
    const lc = parseLifecycle(repealedXml);
    expect(lc.is_in_force).toBe(false);
    expect(lc.date_in_force_end).toBe('2018-12-31');
    expect(lc.repealed_by).toEqual(['1050/2018']);
    // Must read the TOP-LEVEL inForce block, not the nested ones inside
    // finlex:amendedBy statute references (e.g. 1.1.2011 for 1049/2010).
    expect(lc.date_entry_into_force).toBe('1999-06-01');
  });

  it('returns is_in_force=null when the document carries no lifecycle metadata (as-enacted originals)', () => {
    const lc = parseLifecycle(originalXml);
    expect(lc.is_in_force).toBeNull();
    expect(lc.date_in_force_end).toBeNull();
    expect(lc.repealed_by).toEqual([]);
  });

  it('fails loud on unknown isInForce vocabulary instead of guessing', () => {
    const mangled = consolidatedXml.replace('finlex:isInForce value="true"', 'finlex:isInForce value="maybe"');
    expect(() => parseLifecycle(mangled)).toThrow(/isInForce/u);
  });
});

describe('deriveSeedStatus (status is a FACT from upstream metadata, never a constant)', () => {
  const inForce = parseLifecycle(consolidatedXml);
  const repealed = parseLifecycle(repealedXml);
  const absent = parseLifecycle(originalXml);

  it('maps isInForce=true to in_force', () => {
    expect(deriveSeedStatus({ docType: 'statute-consolidated', lifecycle: inForce })).toEqual({
      status: 'in_force',
      basis: 'finlex_lifecycle_metadata',
    });
  });

  it('maps isInForce=false with repealedBy/dateInForceEnd to repealed', () => {
    expect(deriveSeedStatus({ docType: 'statute-consolidated', lifecycle: repealed })).toEqual({
      status: 'repealed',
      basis: 'finlex_lifecycle_metadata',
    });
  });

  it('maps isInForce=false with a FUTURE entry-into-force date to not_yet_in_force', () => {
    expect(
      deriveSeedStatus({
        docType: 'statute-consolidated',
        lifecycle: { ...inForce, is_in_force: false, date_entry_into_force: '2099-01-01' },
        today: '2026-06-11',
      })
    ).toEqual({ status: 'not_yet_in_force', basis: 'finlex_lifecycle_metadata' });
  });

  it('FAILS LOUD when a consolidated document carries no isInForce (shape drift)', () => {
    expect(() => deriveSeedStatus({ docType: 'statute-consolidated', lifecycle: absent })).toThrow(
      /isInForce|lifecycle/iu
    );
  });

  it('as-enacted originals (no lifecycle metadata upstream) get the documented default, stamped as unverified', () => {
    expect(deriveSeedStatus({ docType: 'statute', lifecycle: absent })).toEqual({
      status: 'in_force',
      basis: 'as_enacted_default_unverified',
    });
  });

  it('uses lifecycle metadata on an as-enacted document when upstream does provide it', () => {
    expect(deriveSeedStatus({ docType: 'statute', lifecycle: repealed })).toEqual({
      status: 'repealed',
      basis: 'finlex_lifecycle_metadata',
    });
  });
});

describe('stamp readers', () => {
  const stampedSeed = {
    _ingest: {
      doc_type: 'statute-consolidated',
      consolidation_version: '20260380',
      languages: {
        fin: { expression_uri: '/akn/fi/act/statute-consolidated/2018/1050/fin@20260380', consolidation_version: '20260380' },
        swe: { expression_uri: '/akn/fi/act/statute-consolidated/2018/1050/swe@20260380', consolidation_version: '20260380' },
      },
    },
  };

  it('stampedLanguageVersionsOf reads per-language consolidation versions', () => {
    expect(stampedLanguageVersionsOf(stampedSeed)).toEqual({ fin: '20260380', swe: '20260380' });
  });

  it('stampedLanguageVersionsOf surfaces a missing Swedish stamp (omitted-Swedish cohort)', () => {
    const noSwe = JSON.parse(JSON.stringify(stampedSeed));
    delete noSwe._ingest.languages.swe;
    expect(stampedLanguageVersionsOf(noSwe)).toEqual({ fin: '20260380' });
    expect(stampedLanguageVersionsOf({})).toBeNull();
  });

  it('seedStampInfoOf distinguishes stamped-as-enacted from unstamped', () => {
    expect(seedStampInfoOf({ _ingest: { doc_type: 'statute', consolidation_version: null } })).toEqual({
      doc_type: 'statute',
      consolidation_version: null,
      content_absent_version: null,
    });
    expect(seedStampInfoOf({})).toBeNull();
    expect(seedStampInfoOf(stampedSeed)).toEqual({
      doc_type: 'statute-consolidated',
      consolidation_version: '20260380',
      content_absent_version: null,
    });
  });

  it('seedStampInfoOf surfaces the consolidated-content-absent shell version', () => {
    expect(
      seedStampInfoOf({
        _ingest: {
          doc_type: 'statute',
          consolidation_version: null,
          consolidated_content_absent: { version: '20050045', consolidated_to: '2005-01-28' },
        },
      })
    ).toEqual({ doc_type: 'statute', consolidation_version: null, content_absent_version: '20050045' });
  });
});

describe('assertCurrentConsolidation', () => {
  it('accepts a consolidated (ajantasa) expression', () => {
    expect(() => assertCurrentConsolidation(parseVersionIdentity(consolidatedXml))).not.toThrow();
  });

  it('rejects an original (alkup) expression — the exact defect of issue #78', () => {
    expect(() => assertCurrentConsolidation(parseVersionIdentity(originalXml))).toThrow(/alkup|original/iu);
  });
});

describe('compareVersionNumbers', () => {
  it('orders YYYYNNNN consolidation tokens chronologically', () => {
    expect(compareVersionNumbers('20181050', '20230239')).toBeLessThan(0);
    expect(compareVersionNumbers('20230239', '20260380')).toBeLessThan(0);
    expect(compareVersionNumbers('20260380', '20260380')).toBe(0);
    expect(compareVersionNumbers('20260380', '20181050')).toBeGreaterThan(0);
  });

  it('orders zero-padded statute numbers within a year', () => {
    // 987/2025 (zero-padded 20250987) precedes 1050/2025 (20251050)
    expect(compareVersionNumbers('20250987', '20251050')).toBeLessThan(0);
  });

  it('fails loud on malformed tokens instead of guessing', () => {
    expect(() => compareVersionNumbers('latest', '20260380')).toThrow();
    expect(() => compareVersionNumbers('20260380', '')).toThrow();
  });
});

describe('decideFetch (pre-network)', () => {
  it('fetches when no seed exists', () => {
    expect(decideFetch({ seedExists: false, refresh: false, stampedVersion: null })).toBe('fetch_new');
    expect(decideFetch({ seedExists: false, refresh: true, stampedVersion: null })).toBe('fetch_new');
  });

  it('skips existing seeds outside refresh mode (resume behavior preserved)', () => {
    expect(decideFetch({ seedExists: true, refresh: false, stampedVersion: '20260380' })).toBe('skip_existing');
  });

  it('self-heals unstamped seeds in refresh mode — every pre-fix seed must be re-acquired', () => {
    expect(decideFetch({ seedExists: true, refresh: true, stampedVersion: null })).toBe('refetch_unknown');
  });

  it('probes stamped seeds in refresh mode (fin@latest is both probe and payload)', () => {
    expect(decideFetch({ seedExists: true, refresh: true, stampedVersion: '20260380' })).toBe('refetch_check');
  });
});

describe('decideRewrite (post-fetch)', () => {
  it('rewrites when upstream consolidation is newer than the stamp', () => {
    expect(decideRewrite({ stampedVersion: '20230239', fetchedVersion: '20260380' })).toBe('refetch_changed');
  });

  it('keeps the seed when versions are equal (no git churn)', () => {
    expect(decideRewrite({ stampedVersion: '20260380', fetchedVersion: '20260380' })).toBe('skip_current');
  });

  it('rewrites when the stamp is missing or unparseable — freshness must be PROVEN', () => {
    expect(decideRewrite({ stampedVersion: null, fetchedVersion: '20260380' })).toBe('refetch_unknown');
    expect(decideRewrite({ stampedVersion: 'garbage', fetchedVersion: '20260380' })).toBe('refetch_unknown');
  });

  it('REFUSES to rewrite when upstream serves an OLDER expression than the stamp (stale upstream anomaly)', () => {
    // The stamp PROVES a newer consolidation was served before (fin@latest sits
    // behind a ~10-min cache, so an older response is a realistic mid-run
    // occurrence). Rewriting would erase newer text AND its provable stamp.
    expect(decideRewrite({ stampedVersion: '20260380', fetchedVersion: '20230239' })).toBe('stale_upstream');
  });

  it('rewrites when the fetched expression carries no version (original as-enacted path)', () => {
    expect(decideRewrite({ stampedVersion: null, fetchedVersion: null })).toBe('refetch_unknown');
  });
});
