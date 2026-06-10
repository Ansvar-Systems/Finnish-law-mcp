/**
 * --seeds-only candidate derivation (issue #78 repair run scoping):
 * a refresh sweep must walk the EXISTING corpus, not the remote catalogue —
 * otherwise a "refresh" silently expands the corpus with every statute Finlex
 * lists. Candidates come from data/seed/*.json; the historical fetch token
 * (e.g. '39-001') is recovered from the stored expression URL when present.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveSeedCandidates } from '../../scripts/ingest-finlex-bulk.js';

describe('deriveSeedCandidates', () => {
  let seedDir: string;

  beforeEach(() => {
    seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finlex-seeds-'));
  });

  function writeSeed(name: string, content: unknown): void {
    fs.writeFileSync(path.join(seedDir, name), JSON.stringify(content), 'utf-8');
  }

  it('derives candidates from seed filenames and recovers fetch tokens from URLs', () => {
    writeSeed('1050_2018.json', {
      id: '1050/2018',
      url: 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/2018/1050/fin@20260380',
    });
    writeSeed('39_1889.json', {
      id: '39/1889',
      url: 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/1889/39-001/fin@',
    });
    // legacy hand-made seed with a www.finlex.fi URL: token falls back to the number
    writeSeed('434_2003.json', {
      id: '434/2003',
      url: 'https://www.finlex.fi/fi/laki/alkup/2003/20030434',
    });

    const candidates = deriveSeedCandidates(seedDir);
    const byId = new Map(candidates.map(c => [c.canonical_id, c]));

    expect(byId.get('1050/2018')?.number_token).toBe('1050');
    expect(byId.get('1050/2018')?.year).toBe('2018');
    expect(byId.get('39/1889')?.number_token).toBe('39-001');
    expect(byId.get('434/2003')?.number_token).toBe('434');
    expect(candidates).toHaveLength(3);
  });

  it('ignores non-statute seed artifacts', () => {
    writeSeed('1050_2018.json', { id: '1050/2018' });
    writeSeed('_finlex-statutes-manifest.json', { count: 0 });
    writeSeed('_cross_references.json', []);
    writeSeed('eu-references.json', { eu_documents: [] });

    const candidates = deriveSeedCandidates(seedDir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].canonical_id).toBe('1050/2018');
  });

  it('sorts candidates deterministically (year, then number)', () => {
    writeSeed('1000_2007.json', { id: '1000/2007' });
    writeSeed('9_2007.json', { id: '9/2007' });
    writeSeed('100_2005.json', { id: '100/2005' });

    const ids = deriveSeedCandidates(seedDir).map(c => c.canonical_id);
    expect(ids).toEqual(['100/2005', '9/2007', '1000/2007']);
  });
});
