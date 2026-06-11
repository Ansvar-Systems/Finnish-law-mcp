/**
 * Freshness-classification tests (PR #79 round-2).
 *
 * Two defect classes locked down here:
 *  - check-updates:241 — "stamped as-enacted" (doc_type 'statute',
 *    consolidation_version null: the legitimate consolidated-404 cohort,
 *    ~60% of the corpus) was conflated with "unstamped". The stamp EXISTS and
 *    proves the as-enacted expression; flagging it update-needed made the
 *    checker exit 1 forever (re-ingest reproduces the same stamp).
 *  - check-updates:253 — absence from the upstream consolidated list was
 *    conflated with "no consolidated work upstream" even for seeds whose
 *    stamp PROVES a consolidation existed; plus list entries that stopped
 *    matching the URI regex were dropped silently (no counter, no failure).
 */
import { describe, it, expect } from 'vitest';
import {
  classifySeedFreshness,
  collectNewestVersions,
  assertListShape,
} from '../../scripts/check-updates.js';

describe('classifySeedFreshness', () => {
  it('flags UNSTAMPED seeds: freshness unprovable, re-ingest', () => {
    const verdict = classifySeedFreshness(null, null);
    expect(verdict.has_update).toBe(true);
    expect(verdict.error).toMatch(/unprovable/iu);
  });

  it('stamped AS-ENACTED with no consolidated work upstream is UP TO DATE (not "unstamped")', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute', consolidation_version: null, content_absent_version: null },
      null
    );
    expect(verdict.has_update).toBe(false);
    expect(verdict.error).toBeUndefined();
  });

  it('stamped AS-ENACTED gains an update when a consolidation APPEARS upstream', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute', consolidation_version: null, content_absent_version: null },
      '20260380'
    );
    expect(verdict.has_update).toBe(true);
    expect(verdict.error).toMatch(/appeared/iu);
  });

  it('compares stamped consolidated seeds against the upstream version', () => {
    const stamp = { doc_type: 'statute-consolidated' as const, consolidation_version: '20230239', content_absent_version: null };
    expect(classifySeedFreshness(stamp, '20260380').has_update).toBe(true);
    expect(classifySeedFreshness(stamp, '20230239').has_update).toBe(false);
  });

  it('treats a stamped-CONSOLIDATED seed missing from the upstream list as a LOUD anomaly, not up-to-date', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute-consolidated', consolidation_version: '20230239', content_absent_version: null },
      null
    );
    expect(verdict.has_update).toBe(true);
    expect(verdict.error).toMatch(/anomal/iu);
  });

  it('compares contentAbsent-fallback seeds via the stamped SHELL version (no permanent re-flag loop)', () => {
    const stamp = { doc_type: 'statute' as const, consolidation_version: null, content_absent_version: '20050045' };
    expect(classifySeedFreshness(stamp, '20050045').has_update).toBe(false);
    expect(classifySeedFreshness(stamp, '20260001').has_update).toBe(true);
  });

  it('flags stamps with unparseable consolidation tokens as unprovable', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute-consolidated', consolidation_version: 'garbage', content_absent_version: null },
      '20260380'
    );
    expect(verdict.has_update).toBe(true);
    expect(verdict.error).toMatch(/unprovable/iu);
  });
});

describe('consolidated-list parsing (no silent regex drops)', () => {
  const fin = (uri: string) => ({ akn_uri: uri });

  it('collects the newest fin@ version per statute and counts what it saw', () => {
    const versions = new Map<string, string>();
    const stats = collectNewestVersions(
      [
        fin('https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/2018/1050/fin@20230239'),
        fin('/akn/fi/act/statute-consolidated/2018/1050/fin@20260380'),
        fin('/akn/fi/act/statute-consolidated/2018/1050/swe@20260380'),
      ],
      versions
    );
    expect(versions.get('1050/2018')).toBe('20260380');
    expect(stats.finCount).toBe(2);
    expect(stats.otherLanguageCount).toBe(1);
    expect(stats.unrecognized).toEqual([]);
  });

  it('records UNRECOGNIZED entries instead of dropping them silently', () => {
    const versions = new Map<string, string>();
    const stats = collectNewestVersions(
      [fin('/akn/fi/act/some-new-doctype/2018/1050/fin@20260380'), { akn_uri: undefined }],
      versions
    );
    expect(stats.unrecognized).toHaveLength(2);
  });

  it('assertListShape fails loud on unrecognized entries (shape drift)', () => {
    expect(() =>
      assertListShape({ entriesSeen: 3, finCount: 2, otherLanguageCount: 0, unrecognized: ['/akn/weird'] }, '2018')
    ).toThrow(/unrecognized/iu);
  });

  it('assertListShape fails loud when entries exist but NONE parsed as fin@ (zero-parse drift)', () => {
    expect(() =>
      assertListShape({ entriesSeen: 10, finCount: 0, otherLanguageCount: 10, unrecognized: [] }, '2018')
    ).toThrow(/zero|none/iu);
  });

  it('assertListShape accepts an empty year (no consolidated works is a valid state)', () => {
    expect(() =>
      assertListShape({ entriesSeen: 0, finCount: 0, otherLanguageCount: 0, unrecognized: [] }, '1899')
    ).not.toThrow();
  });
});

describe('bare-@ consolidated list entries (PR #79 round 3)', () => {
  // Live-verified: never-amended consolidations appear ONLY as bare-@ akn_uris
  // (empty version token) while the served document carries FRBRversionNumber.
  it('a stamped-consolidated seed with a bare-@ remote entry is CURRENT, not an anomaly', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute-consolidated', consolidation_version: '19990005', content_absent_version: null },
      '',
    );
    expect(verdict.has_update).toBe(false);
  });

  it('a stamped as-enacted seed with a bare-@ remote entry IS stale (a consolidation exists upstream)', () => {
    const verdict = classifySeedFreshness(
      { doc_type: 'statute', consolidation_version: null, content_absent_version: null },
      '',
    );
    expect(verdict.has_update).toBe(true);
  });
});
