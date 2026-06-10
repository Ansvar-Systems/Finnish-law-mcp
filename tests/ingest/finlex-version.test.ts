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

  it('rewrites when upstream is OLDER than the stamp (inconsistent — re-stamp settles it)', () => {
    expect(decideRewrite({ stampedVersion: '20260380', fetchedVersion: '20230239' })).toBe('refetch_unknown');
  });

  it('rewrites when the fetched expression carries no version (original as-enacted path)', () => {
    expect(decideRewrite({ stampedVersion: null, fetchedVersion: null })).toBe('refetch_unknown');
  });
});
