#!/usr/bin/env tsx
/**
 * Bulk Finlex ingestion for free-tier seed generation.
 *
 * Default behavior:
 * - Pull statute list from Finlex open data (BOTH list endpoints — see below)
 * - Deduplicate versioned statute numbers (keep latest variant per law id)
 * - Ingest each statute into deterministic `data/seed/{number}_{year}.json`
 * - Write ingestion report + manifest for reproducibility
 *
 * Enumeration discipline (issue #82): the worklist is enumerated from BOTH
 * Finlex list endpoints, unioned by canonical (year/number) id:
 *
 *   - act/statute-consolidated/list — the in-force/amended corpus. One row per
 *     (act, language, consolidation-version-date), so an amended act appears
 *     MANY times: `…/statute-consolidated/2014/610/fin@20220667`,
 *     `…/fin@20230183`, `…/fin@`, … . The dated `@YYYYNNNN` suffix is a
 *     consolidation expression, NOT part of the act's number — it is parsed off
 *     and discarded; all rows for one act collapse to a single candidate.
 *   - act/statute/list — the as-enacted corpus (bare `{lang}@`, status NEW).
 *     Carries acts that were never amended (and therefore have no consolidated
 *     expression) so they are not dropped.
 *
 * WHY BOTH (the bug this fixes): the prior pipeline enumerated ONLY the
 * as-enacted `statute/list`. Acts whose presence in the worklist must be
 * guaranteed — the financial pillars (610/2014 luottolaitoslaki, 747/2012,
 * 521/2008, 878/2008, 1286/2014, 611/2014) and the Penal Code (39/1889) — were
 * dropped or mis-enumerated, so 4 of 5 financial pillars (the exact acts the
 * re-ingestion exists to fix) were absent from a 42,534-row worklist while
 * 444/2017 survived. The consolidated list is the authoritative in-force
 * enumeration; the as-enacted list backfills never-amended acts. A named-
 * must-have assertion (REQUIRED_STATUTES) fail-closes the run if any core act
 * is still missing after the union — the census floor did NOT catch this
 * (5,550 >= the 2,500 floor passed while core acts were missing).
 *
 * Version discipline (issue #78): each statute is acquired from the CURRENT
 * consolidation (statute-consolidated/{y}/{n}/fin@latest) and version-stamped
 * (`_ingest`). The enumeration NEVER carries a list-derived `@YYYYNNNN` version
 * suffix into the fetch — `ingest-finlex.ts` resolves `fin@latest` from the
 * (year, number_token) pair. (`number_token` may carry a `-NNN` sub-number,
 * e.g. `39-001`, which IS part of the act identity on Finlex and IS kept.)
 * `--refresh` re-walks existing seeds keyed on that stamp:
 * unstamped seeds (pre-fix, as-enacted content) self-heal unconditionally;
 * stamped seeds are refetched and rewritten only when upstream has a newer
 * consolidation.
 *
 * Usage:
 *   npm run ingest:bulk
 *   npm run ingest:bulk -- --from-year 2000 --resume
 *   npm run ingest:bulk -- --refresh
 *   npm run ingest:bulk -- --limit 250
 *   npm run ingest:bulk -- --cache-only
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { ingestFinlexStatute, type IngestOutcome } from './ingest-finlex.js';
import { FINLEX_REQUEST_DELAY_MS, FINLEX_USER_AGENT } from './lib/finlex-http.js';
import { decideFetch, stampedLanguageVersionsOf, stampedVersionOf } from './lib/finlex-version.js';
import { writeFileAtomicSync } from './lib/fs-atomic.js';

const FINLEX_LIST_URL = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/list';
const FINLEX_CONSOLIDATED_LIST_URL =
  'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/list';

/**
 * The two list endpoints the worklist is unioned from. `statute-consolidated`
 * is enumerated first (the in-force/amended corpus, the authoritative source);
 * `statute` backfills never-amended acts.
 */
const FINLEX_LIST_URLS: readonly string[] = [FINLEX_CONSOLIDATED_LIST_URL, FINLEX_LIST_URL];

/**
 * Named-must-have core statutes that MUST survive enumeration (issue #82).
 * The census floor counts statutes but is blind to WHICH ones are present, so a
 * worklist can clear the floor while missing exactly the acts the re-ingestion
 * exists to fix. This list fail-closes the run if any of them is absent after
 * the union — the financial pillars + the Penal Code + the Constitution. The
 * fleet-side mirror is `mcps/finnish-law/fleet-meta.json`
 * `content_quality.required_statutes` (enforced at build/swap time).
 */
export const REQUIRED_STATUTES: readonly string[] = [
  '610/2014', // luottolaitoslaki (Credit Institutions Act)
  '747/2012', // arvopaperimarkkinoita koskeva sääntely (Securities Markets sphere)
  '521/2008', // sijoituspalvelut / vakuutusyhtiöt sphere
  '878/2008',
  '1286/2014', // sijoituspalvelulaki (Investment Services Act)
  '611/2014',
  '444/2017',
  '39/1889', // rikoslaki (Penal Code)
  '731/1999', // Suomen perustuslaki (Constitution of Finland)
];

const USER_AGENT = FINLEX_USER_AGENT;
const PAGE_LIMIT = 10; // Finlex endpoint enforces limit <= 10
const REQUEST_DELAY_MS = FINLEX_REQUEST_DELAY_MS; // politeness floor: >=2s per request
const SEED_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/seed');
const LIST_CACHE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../data/source/finlex/statute-list-fin.json'
);
const REPORT_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../reports/ingest'
);
const REPORT_PATH = path.join(REPORT_DIR, 'finlex-bulk-latest.json');

/**
 * Durable, run-stamped report path (Dutch round-2 lesson: report files are
 * run-stamped, never a fixed name a later smoke run overwrites). The report
 * is flushed after every candidate so a killed sweep still leaves a complete
 * record of what it did.
 */
export function runReportPath(startedAt: string): string {
  const stamp = startedAt.replace(/\.\d{3}Z$/u, 'Z').replace(/:/gu, '-');
  return path.join(REPORT_DIR, `finlex-bulk-run-${stamp}.json`);
}

/**
 * Failure taxonomy for the abort policy: rate limiting and sustained
 * transport outages must stop the sweep (continuing burns the whole worklist
 * at retry-exhaustion speed); per-document failures are enumerated and the
 * sweep moves on.
 */
export function classifyIngestFailure(message: string): 'rate_limited' | 'transport' | 'other' {
  if (/HTTP 429/u.test(message)) return 'rate_limited';
  if (/failed after \d+ attempts/u.test(message)) return 'transport';
  return 'other';
}

/** Consecutive exhausted-retry transport failures that abort the sweep. */
export const TRANSPORT_ABORT_THRESHOLD = 5;
const MANIFEST_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../data/seed/_finlex-statutes-manifest.json'
);

interface CLIOptions {
  fromYear?: number;
  toYear?: number;
  limit?: number;
  maxPages: number;
  resume: boolean;
  /** Version-keyed refresh of existing seeds (overrides --resume skipping). */
  refresh: boolean;
  /**
   * Candidates from data/seed/*.json instead of the remote catalogue list.
   * A refresh sweep must walk the EXISTING corpus — list-driven candidates
   * would silently expand it with every statute Finlex lists.
   */
  seedsOnly: boolean;
  refreshList: boolean;
  cacheOnly: boolean;
}

interface RemoteEntry {
  akn_uri?: string;
  status?: string;
}

interface StatuteCandidate {
  canonical_id: string;
  canonical_number: string;
  year: string;
  number_token: string;
  version: number;
  source_uri: string;
}

interface CachePayload {
  generated_at: string;
  source: string;
  params: Record<string, string | number | boolean>;
  entries: RemoteEntry[];
}

interface IngestionFailure {
  statute_id: string;
  number_token: string;
  reason: string;
}

interface IngestionReport {
  started_at: string;
  finished_at: string;
  options: CLIOptions;
  list_entries: number;
  unique_candidates: number;
  selected_candidates: number;
  ingested: number;
  skipped_existing: number;
  /** Refresh runs: seeds whose stamped consolidation already matches upstream. */
  skipped_current: number;
  /** Statutes with no consolidated document upstream (definitive 404) — as-enacted original acquired. */
  consolidation_absent: string[];
  /** Consolidated expression was an empty contentAbsent shell — as-enacted text seeded, stamped. */
  content_absent_fallback: string[];
  /** Upstream served an expression OLDER than the seed stamp — newer seed kept, anomaly surfaced. */
  stale_upstream: string[];
  /** Statutes whose Swedish text was omitted, by reason. */
  swedish_omitted: { not_available: string[]; version_mismatch: string[] };
  failed: number;
  aborted_reason?: string;
  failures: IngestionFailure[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCanonicalNumberToken(token: string): string {
  const trimmed = token.trim();
  const withVersion = trimmed.match(/^(\d+)-\d+$/u);
  const base = withVersion ? withVersion[1] : trimmed;
  const normalized = base.replace(/^0+(?=\d)/u, '');
  return normalized.length > 0 ? normalized : '0';
}

function parseVersion(token: string): number {
  const match = token.match(/-(\d+)$/u);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse a Finlex AKN list `akn_uri` into a statute candidate.
 *
 * Accepts BOTH doctypes — `…/act/statute/{y}/{n}/{lang}@` (as-enacted, bare)
 * and `…/act/statute-consolidated/{y}/{n}/{lang}@{VER?}` (consolidation, where
 * VER is an optional `YYYYNNNN` date). The trailing `@VER` is a consolidation
 * EXPRESSION, never part of the act number — the regex stops at `{lang}@`, so
 * `…/610/fin@20220667` and `…/610/fin@` both yield number_token `610` and
 * canonical id `610/2014`. The fetch resolves `fin@latest` from the (year,
 * number_token) pair; a list-derived date is never carried into the fetch.
 *
 * `number_token` retains a `-NNN` sub-number (e.g. `39-001` for the Penal Code)
 * because that IS part of the act's identity on the consolidated endpoint
 * (`statute-consolidated/1889/39-001/fin@latest` is the only URI that resolves;
 * plain `39` 404s).
 */
export function parseAknUri(uri: string | undefined): StatuteCandidate | null {
  if (!uri) return null;
  const match = uri.match(/\/act\/statute(?:-consolidated)?\/(\d{4})\/([^/]+)\/(?:fin|swe)@/u);
  if (!match) return null;

  const year = match[1];
  const numberToken = match[2];
  const canonicalNumber = normalizeCanonicalNumberToken(numberToken);
  const canonicalId = `${canonicalNumber}/${year}`;

  return {
    canonical_id: canonicalId,
    canonical_number: canonicalNumber,
    year,
    number_token: numberToken,
    version: parseVersion(numberToken),
    source_uri: uri,
  };
}

export function pickPreferredCandidate(
  current: StatuteCandidate | undefined,
  incoming: StatuteCandidate
): StatuteCandidate {
  if (!current) return incoming;

  if (incoming.version !== current.version) {
    return incoming.version > current.version ? incoming : current;
  }

  // Prefer token without version suffix when versions are equal.
  const currentHasSuffix = current.number_token.includes('-');
  const incomingHasSuffix = incoming.number_token.includes('-');
  if (currentHasSuffix !== incomingHasSuffix) {
    return incomingHasSuffix ? current : incoming;
  }

  return current;
}

function parseArgs(argv: string[]): CLIOptions {
  const options: CLIOptions = {
    maxPages: 5000,
    resume: false,
    refresh: false,
    seedsOnly: false,
    refreshList: false,
    cacheOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--seeds-only') {
      options.seedsOnly = true;
    } else if (arg === '--refresh-list') {
      options.refreshList = true;
    } else if (arg === '--cache-only') {
      options.cacheOnly = true;
    } else if (arg === '--from-year') {
      options.fromYear = Number(argv[++i]);
    } else if (arg.startsWith('--from-year=')) {
      options.fromYear = Number(arg.split('=')[1]);
    } else if (arg === '--to-year') {
      options.toYear = Number(argv[++i]);
    } else if (arg.startsWith('--to-year=')) {
      options.toYear = Number(arg.split('=')[1]);
    } else if (arg === '--limit') {
      options.limit = Number(argv[++i]);
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.split('=')[1]);
    } else if (arg === '--max-pages') {
      options.maxPages = Number(argv[++i]);
    } else if (arg.startsWith('--max-pages=')) {
      options.maxPages = Number(arg.split('=')[1]);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run ingest:bulk -- [options]');
      console.log('');
      console.log('Options:');
      console.log('  --from-year <YYYY>   Include statutes from this year onward');
      console.log('  --to-year <YYYY>     Include statutes up to this year');
      console.log('  --limit <N>          Ingest at most N deduplicated statutes');
      console.log('  --resume             Skip statutes whose seed files already exist');
      console.log('  --refresh            Version-keyed refresh: refetch seeds whose stamped');
      console.log('                       consolidation is older than upstream; self-heal unstamped seeds');
      console.log('  --seeds-only         Walk existing data/seed/*.json instead of the remote');
      console.log('                       catalogue (no corpus expansion)');
      console.log('  --refresh-list       Force refresh list from Finlex API');
      console.log('  --cache-only         Use cached list only (no network calls)');
      console.log('  --max-pages <N>      Safety cap for paginated list loading');
      process.exit(0);
    }
  }

  if (options.fromYear !== undefined && !Number.isFinite(options.fromYear)) {
    throw new Error('--from-year must be a number');
  }
  if (options.toYear !== undefined && !Number.isFinite(options.toYear)) {
    throw new Error('--to-year must be a number');
  }
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive number');
  }
  if (!Number.isFinite(options.maxPages) || options.maxPages <= 0) {
    throw new Error('--max-pages must be a positive number');
  }

  return options;
}

async function fetchListPage(
  listUrl: string,
  page: number,
  options: CLIOptions
): Promise<RemoteEntry[]> {
  const params = new URLSearchParams({
    format: 'json',
    page: String(page),
    limit: String(PAGE_LIMIT),
    sortBy: 'dateIssued',
    LangAndVersion: 'fin@',
    typeStatute: 'act',
  });

  if (options.fromYear !== undefined) {
    params.set('startYear', String(options.fromYear));
  }
  if (options.toYear !== undefined) {
    params.set('endYear', String(options.toYear));
  }

  const url = `${listUrl}?${params.toString()}`;
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      throw new Error('Unexpected curl response format');
    }

    const body = raw.slice(0, splitAt);
    const statusCode = Number(raw.slice(splitAt + 1).trim());
    if (!Number.isFinite(statusCode)) {
      throw new Error(`Invalid HTTP status code for page ${page}`);
    }

    if (statusCode === 429) {
      if (attempt === maxAttempts) {
        throw new Error(`HTTP 429 from Finlex list endpoint (page ${page}) after ${maxAttempts} attempts`);
      }
      const backoffMs = Math.min(15000, 500 * (2 ** attempt));
      console.log(`  Page ${page}: rate limited (429), retrying in ${Math.round(backoffMs / 1000)}s...`);
      await delay(backoffMs);
      continue;
    }

    if (statusCode >= 400) {
      throw new Error(`HTTP ${statusCode} for page ${page}`);
    }

    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Unexpected list payload for page ${page}`);
    }

    if (parsed.length > 0 && typeof parsed[0] === 'string') {
      throw new Error(`Finlex list endpoint error on page ${page}: ${String(parsed[0])}`);
    }

    return parsed as RemoteEntry[];
  }

  return [];
}

/**
 * Page one list endpoint to exhaustion (or the limit / max-pages cap),
 * accumulating raw entries. `seenCanonicalIds` is shared across both lists so
 * `--limit` counts DISTINCT acts across the union, not per-list.
 */
async function loadOneList(
  listUrl: string,
  options: CLIOptions,
  entries: RemoteEntry[],
  seenCanonicalIds: Set<string>
): Promise<void> {
  const label = listUrl.includes('statute-consolidated') ? 'consolidated' : 'as-enacted';
  console.log(`Fetching Finlex ${label} statute list...`);
  for (let page = 1; page <= options.maxPages; page++) {
    const pageEntries = await fetchListPage(listUrl, page, options);
    if (pageEntries.length === 0) {
      console.log(`  Reached end of ${label} list at page ${page - 1}`);
      break;
    }

    entries.push(...pageEntries);
    for (const entry of pageEntries) {
      const parsed = parseAknUri(entry.akn_uri);
      if (parsed) {
        seenCanonicalIds.add(parsed.canonical_id);
      }
    }

    if (options.limit !== undefined && seenCanonicalIds.size >= options.limit) {
      console.log(`  Reached limit target (${options.limit}) after ${page} ${label} page(s)`);
      break;
    }

    if (page % 100 === 0) {
      console.log(`  Loaded ${entries.length} ${label} list entries (${page} pages)`);
    }
    await delay(REQUEST_DELAY_MS);
  }
}

async function loadListEntries(options: CLIOptions): Promise<RemoteEntry[]> {
  if (options.cacheOnly) {
    if (!fs.existsSync(LIST_CACHE_PATH)) {
      throw new Error(`No cached list found at ${LIST_CACHE_PATH} (cache-only mode)`);
    }
    const payload = JSON.parse(fs.readFileSync(LIST_CACHE_PATH, 'utf-8')) as CachePayload;
    return payload.entries ?? [];
  }

  if (!options.refreshList && fs.existsSync(LIST_CACHE_PATH)) {
    const payload = JSON.parse(fs.readFileSync(LIST_CACHE_PATH, 'utf-8')) as CachePayload;
    if (Array.isArray(payload.entries) && payload.entries.length > 0) {
      console.log(`Using cached Finlex list (${payload.entries.length} entries): ${LIST_CACHE_PATH}`);
      return payload.entries;
    }
  }

  // Union BOTH list endpoints (consolidated first — the in-force/amended
  // authority — then as-enacted to backfill never-amended acts). selectCandidates
  // dedupes the union by canonical (year/number) id, so the multi-version rows
  // the consolidated list emits per act collapse to one candidate.
  const entries: RemoteEntry[] = [];
  const seenCanonicalIds = new Set<string>();
  for (const listUrl of FINLEX_LIST_URLS) {
    await loadOneList(listUrl, options, entries, seenCanonicalIds);
  }
  console.log(
    `  Union: ${entries.length} raw list rows across ${FINLEX_LIST_URLS.length} endpoints, ` +
      `${seenCanonicalIds.size} distinct acts`
  );

  fs.mkdirSync(path.dirname(LIST_CACHE_PATH), { recursive: true });
  const payload: CachePayload = {
    generated_at: new Date().toISOString(),
    source: FINLEX_LIST_URLS.join(', '),
    params: {
      limit: PAGE_LIMIT,
      sortBy: 'dateIssued',
      LangAndVersion: 'fin@',
      typeStatute: 'act',
      fromYear: options.fromYear ?? '',
      toYear: options.toYear ?? '',
    },
    entries,
  };
  writeFileAtomicSync(LIST_CACHE_PATH, JSON.stringify(payload, null, 2));
  console.log(`Cached list payload: ${LIST_CACHE_PATH}`);

  return entries;
}

export function selectCandidates(entries: RemoteEntry[], limit?: number): StatuteCandidate[] {
  const byCanonicalId = new Map<string, StatuteCandidate>();

  for (const entry of entries) {
    const parsed = parseAknUri(entry.akn_uri);
    if (!parsed) continue;
    const current = byCanonicalId.get(parsed.canonical_id);
    byCanonicalId.set(parsed.canonical_id, pickPreferredCandidate(current, parsed));
  }

  const candidates = Array.from(byCanonicalId.values()).sort((a, b) => {
    const yearDiff = Number(a.year) - Number(b.year);
    if (yearDiff !== 0) return yearDiff;
    return Number(a.canonical_number) - Number(b.canonical_number);
  });

  if (limit !== undefined) {
    return candidates.slice(0, limit);
  }
  return candidates;
}

/**
 * Named-must-have enumeration gate (issue #82). Returns the REQUIRED_STATUTES
 * that are ABSENT from the candidate set (empty = all present). The run
 * fail-closes when this is non-empty: a worklist that clears the census floor
 * but is missing core acts is a silent regression of exactly the class this
 * re-ingestion fixes.
 *
 * `required` is unfiltered — when the caller scoped the run with --from-year /
 * --to-year / --limit, a required act may legitimately fall outside the scope,
 * so the gate is only enforced on UNSCOPED full runs (see assertRequiredStatutes).
 */
export function missingRequiredStatutes(
  candidates: StatuteCandidate[],
  required: readonly string[] = REQUIRED_STATUTES
): string[] {
  const present = new Set(candidates.map(c => c.canonical_id));
  return required.filter(id => !present.has(id));
}

/**
 * True when the run's scope is the full corpus (no year window, no limit). Only
 * then can the named-must-have gate be enforced — a windowed/limited run may
 * legitimately exclude a required act.
 */
export function isUnscopedRun(options: Pick<CLIOptions, 'fromYear' | 'toYear' | 'limit'>): boolean {
  return options.fromYear === undefined && options.toYear === undefined && options.limit === undefined;
}

/**
 * Fail-closed assertion for an unscoped full run. Throws if any REQUIRED_STATUTES
 * is missing from the enumerated worklist; a no-op for scoped runs.
 */
export function assertRequiredStatutes(
  candidates: StatuteCandidate[],
  options: Pick<CLIOptions, 'fromYear' | 'toYear' | 'limit'>,
  required: readonly string[] = REQUIRED_STATUTES
): void {
  if (!isUnscopedRun(options)) return;
  const missing = missingRequiredStatutes(candidates, required);
  if (missing.length > 0) {
    throw new Error(
      `Enumeration is missing ${missing.length} required core statute(s): ${missing.join(', ')}. ` +
        'The worklist must include the named financial pillars + Penal Code + Constitution ' +
        '(issue #82). The census floor cannot catch this — fix the list enumeration, do not ' +
        'lower REQUIRED_STATUTES to pass.'
    );
  }
}

function outputPathFor(candidate: StatuteCandidate): string {
  return path.resolve(SEED_DIR, `${candidate.canonical_number}_${candidate.year}.json`);
}

const NON_STATUTE_SEEDS = new Set(['eu-references.json']);

/**
 * Candidates from the existing seed corpus (--seeds-only). The fetch number
 * token (which may carry a historical version suffix, e.g. '39-001') is
 * recovered from the seed's stored expression URL when present.
 */
export function deriveSeedCandidates(seedDir: string): StatuteCandidate[] {
  const candidates: StatuteCandidate[] = [];

  for (const file of fs.readdirSync(seedDir)) {
    if (!file.endsWith('.json') || file.startsWith('_') || NON_STATUTE_SEEDS.has(file)) continue;
    const match = file.match(/^(\d+)_(\d{4})\.json$/u);
    if (!match) continue;

    const canonicalNumber = normalizeCanonicalNumberToken(match[1]);
    const year = match[2];

    let numberToken = canonicalNumber;
    let sourceUri = '';
    try {
      const seed = JSON.parse(fs.readFileSync(path.join(seedDir, file), 'utf-8')) as {
        url?: string;
      };
      const tokenMatch = (seed.url ?? '').match(
        /\/act\/(?:statute|statute-consolidated)\/\d{4}\/([^/]+)\/[a-z]{3}@/u
      );
      if (tokenMatch) {
        numberToken = tokenMatch[1];
        sourceUri = seed.url ?? '';
      }
    } catch {
      // Unreadable seed: keep the filename-derived token; the refresh run
      // will rewrite the seed anyway (refetch_unknown).
    }

    candidates.push({
      canonical_id: `${canonicalNumber}/${year}`,
      canonical_number: canonicalNumber,
      year,
      number_token: numberToken,
      version: parseVersion(numberToken),
      source_uri: sourceUri,
    });
  }

  candidates.sort((a, b) => {
    const yearDiff = Number(a.year) - Number(b.year);
    if (yearDiff !== 0) return yearDiff;
    return Number(a.canonical_number) - Number(b.canonical_number);
  });

  return candidates;
}

function writeManifest(candidates: StatuteCandidate[]): void {
  const manifest = {
    generated_at: new Date().toISOString(),
    source: FINLEX_LIST_URL,
    count: candidates.length,
    statutes: candidates.map(c => ({
      id: c.canonical_id,
      year: c.year,
      number: c.canonical_number,
      source_number_token: c.number_token,
      source_uri: c.source_uri,
    })),
  };

  writeFileAtomicSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export async function ingestFinlexBulk(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const startedAt = new Date().toISOString();

  console.log('Finlex Bulk Ingestion');
  console.log(`  fromYear: ${options.fromYear ?? 'all'}`);
  console.log(`  toYear:   ${options.toYear ?? 'all'}`);
  console.log(`  limit:    ${options.limit ?? 'none'}`);
  console.log(`  resume:   ${options.resume ? 'yes' : 'no'}`);
  console.log(`  refresh:  ${options.refresh ? 'yes (version-keyed)' : 'no'}`);
  console.log(`  scope:    ${options.seedsOnly ? 'existing seeds (--seeds-only)' : 'remote catalogue list'}`);
  console.log('');

  let allCandidates: StatuteCandidate[];
  let selected: StatuteCandidate[];
  let listEntryCount = 0;

  if (options.seedsOnly) {
    allCandidates = deriveSeedCandidates(SEED_DIR);
    if (allCandidates.length === 0) {
      throw new Error(`--seeds-only: no statute seeds found under ${SEED_DIR}`);
    }
    selected = options.limit !== undefined ? allCandidates.slice(0, options.limit) : allCandidates;
  } else {
    const entries = await loadListEntries(options);
    listEntryCount = entries.length;
    allCandidates = selectCandidates(entries);
    // Named-must-have gate: an unscoped full run MUST enumerate the core acts.
    // Checked against allCandidates (pre-limit) so it reflects the true worklist.
    assertRequiredStatutes(allCandidates, options);
    selected = selectCandidates(entries, options.limit);
  }

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  if (!options.seedsOnly) {
    writeManifest(selected);
  }

  const report: IngestionReport = {
    started_at: startedAt,
    finished_at: startedAt,
    options,
    list_entries: listEntryCount,
    unique_candidates: allCandidates.length,
    selected_candidates: selected.length,
    ingested: 0,
    skipped_existing: 0,
    skipped_current: 0,
    consolidation_absent: [],
    content_absent_fallback: [],
    stale_upstream: [],
    swedish_omitted: { not_available: [], version_mismatch: [] },
    failed: 0,
    failures: [],
  };
  const durableReportPath = runReportPath(startedAt);
  const flushReport = (): void => {
    report.finished_at = new Date().toISOString();
    writeFileAtomicSync(durableReportPath, JSON.stringify(report, null, 2));
  };

  console.log(`List entries loaded:      ${listEntryCount}`);
  console.log(`Unique statute candidates: ${allCandidates.length}`);
  console.log(`Selected for ingestion:    ${selected.length}`);
  console.log(`Run report (flushed per statute): ${durableReportPath}`);
  console.log('');

  let consecutiveTransportFailures = 0;

  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];
    const outputPath = outputPathFor(candidate);
    const seedExists = fs.existsSync(outputPath);

    // Version-keyed fetch decision. Outside refresh mode this preserves the
    // historical behavior exactly: --resume skips existing seeds, a plain run
    // re-ingests everything.
    let stampedVersion: string | null = null;
    let stampedSwedishVersion: string | null = null;
    if (seedExists && options.refresh) {
      try {
        const seedJson = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as unknown;
        stampedVersion = stampedVersionOf(seedJson);
        stampedSwedishVersion = stampedLanguageVersionsOf(seedJson)?.swe ?? null;
      } catch {
        stampedVersion = null; // unreadable seed: self-heal via refetch_unknown
        stampedSwedishVersion = null;
      }
      const decision = decideFetch({ seedExists, refresh: true, stampedVersion });
      console.log(
        `[${i + 1}/${selected.length}] ${decision} ${candidate.canonical_id}` +
          (stampedVersion ? ` (stamped ${stampedVersion})` : ' (unstamped — self-heal)')
      );
    } else if (options.resume && seedExists) {
      report.skipped_existing += 1;
      if ((i + 1) % 50 === 0) {
        console.log(`[${i + 1}/${selected.length}] resume-skip ${candidate.canonical_id}`);
      }
      continue;
    } else {
      console.log(`[${i + 1}/${selected.length}] ingest ${candidate.canonical_id} (source ${candidate.number_token})`);
    }

    try {
      const outcome: IngestOutcome = await ingestFinlexStatute(candidate.canonical_id, outputPath, {
        fetchNumberToken: candidate.number_token,
        canonicalStatuteId: candidate.canonical_id,
        existingStampedVersion: stampedVersion,
        existingStampedSwedishVersion: stampedSwedishVersion,
      });
      consecutiveTransportFailures = 0;
      if (outcome.decision === 'stale_upstream') {
        report.stale_upstream.push(candidate.canonical_id);
      } else if (outcome.decision === 'skip_current' || !outcome.written) {
        report.skipped_current += 1;
      } else {
        report.ingested += 1;
      }
      if (outcome.consolidationAbsent) {
        report.consolidation_absent.push(candidate.canonical_id);
      }
      if (outcome.contentAbsentFallback) {
        report.content_absent_fallback.push(candidate.canonical_id);
      }
      if (outcome.swedish === 'omitted_not_available') {
        report.swedish_omitted.not_available.push(candidate.canonical_id);
      } else if (outcome.swedish === 'omitted_version_mismatch') {
        report.swedish_omitted.version_mismatch.push(candidate.canonical_id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed += 1;
      report.failures.push({
        statute_id: candidate.canonical_id,
        number_token: candidate.number_token,
        reason: message,
      });
      console.error(`  ERROR: ${message}`);

      const kind = classifyIngestFailure(message);
      if (kind === 'rate_limited') {
        report.aborted_reason = `rate_limited_at_${candidate.canonical_id}`;
        console.error('  Aborting run due to Finlex rate limiting.');
        flushReport();
        break;
      }
      if (kind === 'transport') {
        consecutiveTransportFailures += 1;
        if (consecutiveTransportFailures >= TRANSPORT_ABORT_THRESHOLD) {
          // A sustained outage must stop the sweep: every further candidate
          // costs full retry exhaustion (~16s) and accomplishes nothing.
          report.aborted_reason = `transport_outage_at_${candidate.canonical_id}`;
          console.error(
            `  Aborting run: ${consecutiveTransportFailures} consecutive transport failures — ` +
              'sustained outage, resume with the same command once connectivity returns.'
          );
          flushReport();
          break;
        }
      } else {
        consecutiveTransportFailures = 0;
      }
    }

    flushReport();
    await delay(REQUEST_DELAY_MS);
  }

  flushReport();
  writeFileAtomicSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('');
  console.log('Bulk ingestion summary');
  console.log(`  Ingested (written):    ${report.ingested}`);
  console.log(`  Skipped existing:      ${report.skipped_existing}`);
  console.log(`  Skipped current:       ${report.skipped_current}`);
  console.log(`  Consolidation absent:  ${report.consolidation_absent.length} (as-enacted original acquired)`);
  console.log(`  ContentAbsent shells:  ${report.content_absent_fallback.length} (as-enacted fallback, stamped)`);
  console.log(`  Stale upstream:        ${report.stale_upstream.length} (newer seed kept)`);
  console.log(`  Swedish omitted:       ${report.swedish_omitted.not_available.length} unavailable, ${report.swedish_omitted.version_mismatch.length} version-mismatch`);
  console.log(`  Failed:                ${report.failed}`);
  if (report.aborted_reason) {
    console.log(`  Aborted reason:        ${report.aborted_reason}`);
  }
  console.log(`  Run report:            ${durableReportPath}`);
  console.log(`  Report (latest):       ${REPORT_PATH}`);
  console.log(`  Manifest:              ${MANIFEST_PATH}`);

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  ingestFinlexBulk().catch(error => {
    console.error('Bulk ingestion failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
