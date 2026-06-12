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
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseFinlexXml, ingestFinlexStatute } from '../../scripts/ingest-finlex.js';

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

    it('extracts the statuteTextWrapper text (here: the act\'s entry-into-force sentence) under ref "teksti"', () => {
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

  describe('pairing-symmetry warning (PR #83 review P2)', () => {
    it('an FI/SV instance-count mismatch warns instead of dropping Swedish silently', async () => {
      // Swedish carries TWO entryIntoForce containers where Finnish has one:
      // the suffix scheme produces eIds (-1/-2) that never match the bare
      // Finnish eId — the Swedish text cannot pair. That must be LOUD.
      const asymmetricSwe = wrapperOnlyFin.replace(
        /<hcontainer eId="entryIntoForce" name="entryIntoForce">[\s\S]*?<\/hcontainer>/u,
        '<hcontainer eId="entryIntoForce" name="entryIntoForce">' +
          '<content><p>Denna lag träder i kraft den 1 januari 2006.</p></content></hcontainer>' +
          '<hcontainer eId="entryIntoForce2" name="entryIntoForce">' +
          '<content><p>Andra ikraftträdandebestämmelsen.</p></content></hcontainer>'
      );

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi82-pairing-'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const fetchImpl = (async (url: unknown) => {
          const u = String(url);
          if (u.includes('statute-consolidated/2005/1080/')) return new Response('gone', { status: 404 });
          if (u.includes('statute/2005/1080/fin@')) return new Response(wrapperOnlyFin, { status: 200 });
          if (u.includes('statute/2005/1080/swe@')) return new Response(asymmetricSwe, { status: 200 });
          throw new Error(`Unexpected URL in test: ${u}`);
        }) as typeof fetch;

        await ingestFinlexStatute('1080/2005', path.join(tmpDir, '1080_2005.json'), {
          fetchImpl,
          delayMs: 0,
          cacheDir: path.join(tmpDir, 'cache'),
          forensicCacheDir: path.join(tmpDir, 'forensic'),
        });

        const warned = warn.mock.calls.map(args => String(args[0])).join('\n');
        expect(warned).toContain('no Finnish eId counterpart');
        expect(warned).toContain('hcontainer:entryIntoForce-1');
      } finally {
        warn.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
