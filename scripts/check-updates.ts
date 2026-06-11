#!/usr/bin/env tsx
/**
 * Check for updates to ingested Finnish statutes.
 *
 * Version-keyed (issue #78): pages the statute-CONSOLIDATED list, takes the
 * newest consolidation version token (`fin@YYYYNNNN`) per statute, and
 * compares it against the `_ingest.consolidation_version` stamp in the local
 * seed files. The previous implementation paged the ORIGINAL statute list,
 * whose entries never change when a statute is amended — it was structurally
 * blind to exactly the staleness it was meant to detect.
 *
 * A statute whose seed carries no stamp is reported as update-needed: its
 * freshness cannot be proven (it predates version-stamped acquisition and may
 * hold as-enacted text).
 *
 * Usage: npm run check-updates
 * Exit codes: 0 = everything provably current, 1 = updates needed or errors.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { FINLEX_REQUEST_DELAY_MS, FINLEX_USER_AGENT } from './lib/finlex-http.js';
import { compareVersionNumbers, seedStampInfoOf, type SeedStampInfo } from './lib/finlex-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.db');
const SEED_DIR = path.resolve(__dirname, '../data/seed');

const FINLEX_CONSOLIDATED_LIST_URL =
  'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/list';
const USER_AGENT = FINLEX_USER_AGENT;
const REQUEST_DELAY_MS = FINLEX_REQUEST_DELAY_MS; // politeness floor: >=2s per request
const PAGE_LIMIT = 10; // Finlex list endpoint enforces max 10
const MAX_PAGES_PER_YEAR = 400;

interface LocalDocument {
  id: string;
  title: string;
  type: string;
  status: string;
  last_updated: string | null;
}

interface RemoteEntry {
  akn_uri?: string;
  status?: string;
}

interface UpdateCheckResult {
  id: string;
  title: string;
  stamped_version: string | null;
  remote_version: string | null;
  has_update: boolean;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toFinnishStatuteId(id: string): string {
  if (/^\d+\/\d{4}$/u.test(id)) {
    return id;
  }
  if (/^\d{4}:\d+$/u.test(id)) {
    const [year, number] = id.split(':');
    return `${number}/${year}`;
  }
  return id;
}

function yearFromStatuteId(id: string): string | null {
  if (/^\d+\/\d{4}$/u.test(id)) {
    return id.split('/')[1];
  }
  if (/^\d{4}:\d+$/u.test(id)) {
    return id.split(':')[0];
  }
  return null;
}

/** Parse '/act/statute-consolidated/{year}/{number}/{lang}@{version}' into id + lang + version token. */
function parseConsolidatedAknUri(
  uri: string | undefined
): { id: string; lang: string; version: string } | null {
  if (!uri) return null;
  const match = uri.match(
    /\/act\/statute-consolidated\/(\d{4})\/(\d+)(?:-\d+)?\/([a-z]{3})@([0-9a-zA-Z]*)$/u
  );
  if (!match) return null;
  return { id: `${match[2]}/${match[1]}`, lang: match[3], version: match[4] };
}

function newerVersion(current: string | undefined, incoming: string): string {
  if (!current) return incoming;
  // Bare '@' (empty token) is the enactment-dated expression — any dated
  // token outranks it.
  if (!/^\d{8}$/u.test(incoming)) return current;
  if (!/^\d{8}$/u.test(current)) return incoming;
  return compareVersionNumbers(incoming, current) > 0 ? incoming : current;
}

export interface ListShapeStats {
  entriesSeen: number;
  finCount: number;
  otherLanguageCount: number;
  unrecognized: string[];
}

/**
 * Fold one page of consolidated-list entries into the versions map, counting
 * exactly what was seen. Entries that match no recognized shape are RECORDED,
 * never silently dropped — if the upstream URI shape drifts, the run must
 * fail loud instead of reporting "0 statutes, everything current".
 */
export function collectNewestVersions(
  entries: RemoteEntry[],
  versions: Map<string, string>
): ListShapeStats {
  const stats: ListShapeStats = {
    entriesSeen: entries.length,
    finCount: 0,
    otherLanguageCount: 0,
    unrecognized: [],
  };
  for (const entry of entries) {
    const parsed = parseConsolidatedAknUri(entry.akn_uri);
    if (!parsed) {
      stats.unrecognized.push(entry.akn_uri ?? '(no akn_uri)');
      continue;
    }
    if (parsed.lang !== 'fin') {
      stats.otherLanguageCount += 1; // Swedish twins are expected, not drift
      continue;
    }
    stats.finCount += 1;
    versions.set(parsed.id, newerVersion(versions.get(parsed.id), parsed.version));
  }
  return stats;
}

/** Fail loud on list shape drift: unrecognized entries or an all-entries-unparseable page set. */
export function assertListShape(stats: ListShapeStats, context: string): void {
  if (stats.unrecognized.length > 0) {
    const sample = stats.unrecognized.slice(0, 5).join(', ');
    throw new Error(
      `${context}: ${stats.unrecognized.length} unrecognized consolidated-list entr(ies) — upstream URI ` +
        `shape drift, refusing to report freshness from a partial parse (sample: ${sample})`
    );
  }
  if (stats.entriesSeen > 0 && stats.finCount === 0) {
    throw new Error(
      `${context}: ${stats.entriesSeen} list entries but NONE parsed as a fin@ consolidated URI — ` +
        'shape drift, refusing to conclude "no consolidated works upstream"'
    );
  }
}

function mergeStats(into: ListShapeStats, page: ListShapeStats): void {
  into.entriesSeen += page.entriesSeen;
  into.finCount += page.finCount;
  into.otherLanguageCount += page.otherLanguageCount;
  into.unrecognized.push(...page.unrecognized);
}

/** Newest consolidation version token per statute id, for one work year. */
async function fetchNewestVersionsForYear(year: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const yearStats: ListShapeStats = { entriesSeen: 0, finCount: 0, otherLanguageCount: 0, unrecognized: [] };

  for (let page = 1; page <= MAX_PAGES_PER_YEAR; page++) {
    const params = new URLSearchParams({
      format: 'json',
      page: String(page),
      limit: String(PAGE_LIMIT),
      sortBy: 'number',
      startYear: year,
      endYear: year,
    });

    const url = `${FINLEX_CONSOLIDATED_LIST_URL}?${params.toString()}`;
    const raw = execFileSync(
      'curl',
      [
        '-sS',
        '-L',
        '-A',
        USER_AGENT,
        '-H',
        'Accept: application/json',
        '-w',
        '\n%{http_code}',
        url,
      ],
      { encoding: 'utf-8' }
    );

    const splitAt = raw.lastIndexOf('\n');
    if (splitAt === -1) {
      throw new Error('Unexpected curl response');
    }

    const body = raw.slice(0, splitAt);
    const statusCode = Number(raw.slice(splitAt + 1).trim());
    if (!Number.isFinite(statusCode) || statusCode >= 400) {
      throw new Error(`HTTP ${statusCode}`);
    }

    const data = JSON.parse(body) as RemoteEntry[];
    const entries = Array.isArray(data) ? data : [];
    if (entries.length === 0) {
      break;
    }

    mergeStats(yearStats, collectNewestVersions(entries, versions));

    if (entries.length < PAGE_LIMIT) {
      break;
    }
    if (page === MAX_PAGES_PER_YEAR) {
      // Never silently truncate: a partial list would mask updates.
      throw new Error(`year ${year}: consolidated list exceeds ${MAX_PAGES_PER_YEAR} pages — raise the cap`);
    }

    await delay(REQUEST_DELAY_MS);
  }

  assertListShape(yearStats, `year ${year}`);
  return versions;
}

function stampInfoFor(statuteId: string): SeedStampInfo | null {
  const safe = toFinnishStatuteId(statuteId).replace('/', '_');
  const seedPath = path.join(SEED_DIR, `${safe}.json`);
  if (!fs.existsSync(seedPath)) return null;
  try {
    return seedStampInfoOf(JSON.parse(fs.readFileSync(seedPath, 'utf-8')));
  } catch {
    return null;
  }
}

const VERSION_TOKEN_RE = /^\d{8}$/u;

export interface FreshnessVerdict {
  has_update: boolean;
  stamped_version: string | null;
  error?: string;
}

/**
 * Classify one seed's freshness from its full stamp identity vs the newest
 * upstream consolidation version (null = absent from the consolidated list).
 *
 * The load-bearing distinctions (PR #79 round-2):
 *  - stamped AS-ENACTED (doc_type 'statute', consolidation_version null) is
 *    NOT "unstamped": the stamp PROVES the as-enacted expression is the
 *    current text when no consolidated work exists upstream.
 *  - a consolidation APPEARING upstream makes an as-enacted seed stale.
 *  - a stamped-CONSOLIDATED seed missing from the consolidated list is an
 *    anomaly to surface, never silently "up to date".
 */
export function classifySeedFreshness(
  stamp: SeedStampInfo | null,
  remote: string | null
): FreshnessVerdict {
  if (!stamp || stamp.doc_type === null) {
    return {
      has_update: true,
      stamped_version: null,
      error: 'No ingest stamp — freshness unprovable, re-ingest (self-heal)',
    };
  }

  const remoteValid = remote !== null && VERSION_TOKEN_RE.test(remote);

  // The version that proves which consolidation the seed reflects: for
  // contentAbsent fallbacks that is the stamped SHELL version.
  const effectiveVersion = stamp.consolidation_version ?? stamp.content_absent_version;

  if (effectiveVersion === null) {
    // Stamped as-enacted: the legitimate consolidated-404 cohort.
    if (stamp.doc_type !== 'statute') {
      return {
        has_update: true,
        stamped_version: null,
        error: 'Consolidated stamp without a version token — unprovable, re-ingest (self-heal)',
      };
    }
    if (remoteValid) {
      return {
        has_update: true,
        stamped_version: null,
        error: `Consolidation ${remote} appeared upstream — as-enacted seed is stale, re-ingest`,
      };
    }
    // No consolidated work upstream: the stamped as-enacted original IS the
    // current text. Proven, not assumed.
    return { has_update: false, stamped_version: null };
  }

  if (!VERSION_TOKEN_RE.test(effectiveVersion)) {
    return {
      has_update: true,
      stamped_version: effectiveVersion,
      error: `Unparseable stamped version "${effectiveVersion}" — unprovable, re-ingest (self-heal)`,
    };
  }

  if (!remoteValid) {
    // The stamp PROVES a consolidated work existed upstream; its absence from
    // the consolidated list is an anomaly, not a green light.
    return {
      has_update: true,
      stamped_version: effectiveVersion,
      error:
        `Stamped consolidation ${effectiveVersion} but the statute is ABSENT from the upstream ` +
        'consolidated list — anomaly, investigate before trusting freshness',
    };
  }

  return {
    has_update: compareVersionNumbers(remote as string, effectiveVersion) > 0,
    stamped_version: effectiveVersion,
  };
}

async function checkUpdates(): Promise<void> {
  console.log('Finnish Law MCP - Update Checker (version-keyed, statute-consolidated)');
  console.log('');

  if (!fs.existsSync(DB_PATH)) {
    console.log('Database not found:', DB_PATH);
    console.log('Run "npm run build:db" first.');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const documents = db.prepare(`
    SELECT id, title, type, status, last_updated
    FROM legal_documents
    WHERE type = 'statute'
    ORDER BY id
  `).all() as LocalDocument[];
  db.close();

  if (documents.length === 0) {
    console.log('No statutes in database.');
    process.exit(0);
  }

  const years = new Set<string>();
  for (const doc of documents) {
    const year = yearFromStatuteId(doc.id);
    if (year) years.add(year);
  }

  console.log(`Checking ${documents.length} statute(s) across ${years.size} year bucket(s)...`);
  console.log('');

  const remoteVersions = new Map<string, string>();
  const remoteFetchErrors: string[] = [];

  for (const year of [...years].sort()) {
    try {
      process.stdout.write(`  Loading consolidated list for ${year}... `);
      const byYear = await fetchNewestVersionsForYear(year);
      for (const [id, version] of byYear) {
        remoteVersions.set(id, newerVersion(remoteVersions.get(id), version));
      }
      console.log(`${byYear.size} statute(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remoteFetchErrors.push(`${year}: ${message}`);
      console.log(`error: ${message}`);
    }
    await delay(REQUEST_DELAY_MS);
  }

  const results: UpdateCheckResult[] = [];
  for (const doc of documents) {
    const finlexId = toFinnishStatuteId(doc.id);
    const stamp = stampInfoFor(doc.id);
    const remote = remoteVersions.get(finlexId) ?? null;
    const verdict = classifySeedFreshness(stamp, remote);

    results.push({
      id: doc.id,
      title: doc.title,
      stamped_version: verdict.stamped_version,
      remote_version: remote,
      has_update: verdict.has_update,
      error: verdict.error,
    });
  }

  console.log('');
  for (const result of results) {
    process.stdout.write(`  ${result.id} (${result.title.substring(0, 48)})... `);
    if (result.error) {
      console.log(`needs attention: ${result.error}`);
    } else if (result.has_update) {
      console.log(`UPDATE AVAILABLE (${result.stamped_version} -> ${result.remote_version})`);
    } else {
      console.log(`up to date (${result.stamped_version ?? 'as-enacted, no consolidation upstream'})`);
    }
  }

  const updates = results.filter(r => r.has_update);
  const errors = remoteFetchErrors;
  const current = results.filter(r => !r.has_update);

  console.log('');
  console.log(`Up to date: ${current.length}`);
  console.log(`Updates:    ${updates.length}`);
  console.log(`Errors:     ${errors.length}`);

  if (updates.length > 0) {
    console.log('');
    console.log('To re-ingest updated statutes:');
    console.log('  npm run ingest:refresh');
    console.log('or per statute:');
    for (const u of updates.slice(0, 20)) {
      const safeId = toFinnishStatuteId(u.id).replace('/', '_');
      console.log(`  npm run ingest -- ${toFinnishStatuteId(u.id)} data/seed/${safeId}.json`);
    }
    if (updates.length > 20) {
      console.log(`  ... and ${updates.length - 20} more`);
    }
    console.log('  npm run build:db');
    process.exit(1);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkUpdates().catch(error => {
    console.error('Check failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
