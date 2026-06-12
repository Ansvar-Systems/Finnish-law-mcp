/**
 * Extractor shape-gap repair tests (issue #82): 22 as-enacted statutes parse
 * to ZERO provisions because their AKN body holds no <section> elements at
 * all — the text lives in named hcontainers:
 *
 *   <hcontainer name="statuteTextWrapper"><content><p>…   (substantive text)
 *   <hcontainer name="entryIntoForce"><content><p>…       (entry into force)
 *   <hcontainer name="attachments"><hcontainer name="attachment">…<table>…
 *                                                          (annex tables — for
 *                                  "liitteen muuttamisesta" acts the annex IS
 *                                  the substance, e.g. tobacco tax scales)
 *
 * Oracles (real upstream data, captured 2026-06-11 during the issue #78
 * refresh): 1080/2005 (transition provision + entry into force, body also
 * carries an elided-amendment <p class="omission"/>) and 1497/2015 (tobacco
 * tax annex amendment whose only substance beyond entry-into-force is the
 * VEROTAULUKKO annex table).
 *
 * The fallback is SCOPED: it runs only when the section walk yields zero
 * provisions, and it must NEVER extract signatures, preliminary works or
 * other conclusions material as law text.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseFinlexXml } from '../../scripts/ingest-finlex.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/finlex');
const wrapperOnlyFin = fs.readFileSync(
  path.join(FIXTURES, 'statute-2005-1080-fin-original.xml'),
  'utf-8'
);
const annexTableFin = fs.readFileSync(
  path.join(FIXTURES, 'statute-2015-1497-fin-original.xml'),
  'utf-8'
);
const consolidatedFin = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2018-1050-fin-latest.xml'),
  'utf-8'
);
const contentAbsentShell = fs.readFileSync(
  path.join(FIXTURES, 'statute-consolidated-2005-45-fin-contentabsent.xml'),
  'utf-8'
);

describe('named-hcontainer fallback (issue #82 shape gap)', () => {
  describe('1080/2005 — statuteTextWrapper + entryIntoForce', () => {
    const parsed = parseFinlexXml(wrapperOnlyFin, '1080/2005');

    it('parses to non-zero provisions (was ZERO, gate-refused)', () => {
      expect(parsed.provisions.length).toBeGreaterThan(0);
    });

    it('extracts the substantive wrapper text under ref "teksti"', () => {
      const teksti = parsed.provisions.find(p => p.section === 'teksti');
      expect(teksti).toBeDefined();
      expect(teksti!.content).toContain('rekisteröidyssä parisuhteessa');
      // The elided-amendment marker <p class="omission"/> is empty — it must
      // not surface as text.
      expect(teksti!.content.trim().length).toBeGreaterThan(50);
    });

    it('extracts the entry-into-force provision under ref "voimaantulo"', () => {
      const voimaantulo = parsed.provisions.find(p => p.section === 'voimaantulo');
      expect(voimaantulo).toBeDefined();
      expect(voimaantulo!.content).toContain('1 päivänä tammikuuta 2006');
    });

    it('NEVER extracts signatures or preparatory works as law text', () => {
      const all = parsed.provisions.map(p => `${p.title ?? ''} ${p.content}`).join(' ');
      expect(all).not.toContain('TARJA HALONEN');
      expect(all).not.toContain('HE 91/2005');
      expect(all).not.toContain('Tasavallan Presidentti');
    });

    it('is not misread as a contentAbsent shell', () => {
      expect(parsed.contentAbsent).toBe(false);
    });
  });

  describe('1497/2015 — annex-table act (liitteen muuttamisesta)', () => {
    const parsed = parseFinlexXml(annexTableFin, '1497/2015');

    it('parses to non-zero provisions', () => {
      expect(parsed.provisions.length).toBeGreaterThan(0);
    });

    it('extracts the annex table under ref "liite" — the act\'s actual substance', () => {
      const liite = parsed.provisions.find(p => p.section === 'liite');
      expect(liite).toBeDefined();
      expect(liite!.content).toContain('VEROTAULUKKO A');
      expect(liite!.content).toContain('Savukkeet');
    });

    it('extracts the wrapper entry-into-force text under ref "teksti"', () => {
      const teksti = parsed.provisions.find(p => p.section === 'teksti');
      expect(teksti).toBeDefined();
      expect(teksti!.content).toContain('1 päivänä tammikuuta 2016');
    });
  });

  describe('omission-only wrapper (1174/2007 shape)', () => {
    // The wrapper holds ONLY the elided-amendment marker; the act's sole
    // standalone content is its entry-into-force provision.
    const xml = wrapperOnlyFin
      .replace(
        /<hcontainer finlex:outline="Säädöksen teksti" name="statuteTextWrapper">[\s\S]*?<\/hcontainer>/u,
        '<hcontainer finlex:outline="Säädöksen teksti" name="statuteTextWrapper">' +
          '<content><p class="omission"/></content></hcontainer>'
      );
    const parsed = parseFinlexXml(xml, '1080/2005');

    it('does not fabricate an empty "teksti" provision', () => {
      expect(parsed.provisions.find(p => p.section === 'teksti')).toBeUndefined();
    });

    it('still serves the entry-into-force provision', () => {
      const voimaantulo = parsed.provisions.find(p => p.section === 'voimaantulo');
      expect(voimaantulo).toBeDefined();
      expect(voimaantulo!.content).toContain('voimaan');
    });
  });

  describe('scoping: the fallback must not fire for healthy documents', () => {
    it('a sectioned statute parses identically (no wrapper/signature provisions added)', () => {
      const parsed = parseFinlexXml(consolidatedFin, '1050/2018');
      expect(parsed.provisions.length).toBeGreaterThan(0);
      expect(parsed.provisions.every(p => p.section !== 'teksti' && p.section !== 'voimaantulo')).toBe(true);
    });

    it('a contentAbsent shell still parses to zero provisions with the flag set', () => {
      const parsed = parseFinlexXml(contentAbsentShell, '45/2005');
      expect(parsed.provisions.length).toBe(0);
      expect(parsed.contentAbsent).toBe(true);
    });
  });

  describe('stable eIds for bilingual pairing', () => {
    it('fallback provisions carry language-independent eIds', () => {
      const parsed = parseFinlexXml(wrapperOnlyFin, '1080/2005');
      const teksti = parsed.provisions.find(p => p.section === 'teksti');
      const voimaantulo = parsed.provisions.find(p => p.section === 'voimaantulo');
      expect(teksti!.eId).toBe('hcontainer:statuteTextWrapper');
      expect(voimaantulo!.eId).toBe('hcontainer:entryIntoForce');
    });
  });
});
