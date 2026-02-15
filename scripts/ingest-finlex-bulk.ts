#!/usr/bin/env tsx
/**
 * Bulk Finlex ingestion for free-tier seed generation.
 *
 * Default behavior:
 * - Pull statute list from Finlex open data
 * - Deduplicate versioned statute numbers (keep latest variant per law id)
 * - Ingest each statute into deterministic `data/seed/{number}_{year}.json`
 * - Write ingestion report + manifest for reproducibility
 *
 * Usage:
 *   npm run ingest:bulk
 *   npm run ingest:bulk -- --from-year 2000 --resume
 *   npm run ingest:bulk -- --limit 250
 *   npm run ingest:bulk -- --cache-only
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { ingestFinlexStatute } from './ingest-finlex.js';

const FINLEX_LIST_URL = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/list';
const USER_AGENT = 'Finnish-Law-MCP/1.2.2 (https://github.com/Ansvar-Systems/finnish-law-mcp)';
const PAGE_LIMIT = 10; // Finlex endpoint enforces limit <= 10
const REQUEST_DELAY_MS = 300;
const SEED_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/seed');
const LIST_CACHE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../data/source/finlex/statute-list-fin.json'
);
const REPORT_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../reports/ingest/finlex-bulk-latest.json'
);
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

function parseAknUri(uri: string | undefined): StatuteCandidate | null {
  if (!uri) return null;
  const match = uri.match(/\/act\/statute\/(\d{4})\/([^/]+)\/(?:fin|swe)@/u);
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

function pickPreferredCandidate(
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
    refreshList: false,
    cacheOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--resume') {
      options.resume = true;
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

async function fetchListPage(page: number, options: CLIOptions): Promise<RemoteEntry[]> {
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

  const url = `${FINLEX_LIST_URL}?${params.toString()}`;
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

  console.log('Fetching Finlex statute list...');
  const entries: RemoteEntry[] = [];
  const seenCanonicalIds = new Set<string>();
  for (let page = 1; page <= options.maxPages; page++) {
    const pageEntries = await fetchListPage(page, options);
    if (pageEntries.length === 0) {
      console.log(`  Reached end of list at page ${page - 1}`);
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
      console.log(`  Reached limit target (${options.limit}) after ${page} page(s)`);
      break;
    }

    if (page % 100 === 0) {
      console.log(`  Loaded ${entries.length} list entries (${page} pages)`);
    }
    await delay(REQUEST_DELAY_MS);
  }

  fs.mkdirSync(path.dirname(LIST_CACHE_PATH), { recursive: true });
  const payload: CachePayload = {
    generated_at: new Date().toISOString(),
    source: FINLEX_LIST_URL,
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
  fs.writeFileSync(LIST_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`Cached list payload: ${LIST_CACHE_PATH}`);

  return entries;
}

function selectCandidates(entries: RemoteEntry[], limit?: number): StatuteCandidate[] {
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

function outputPathFor(candidate: StatuteCandidate): string {
  return path.resolve(SEED_DIR, `${candidate.canonical_number}_${candidate.year}.json`);
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

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

export async function ingestFinlexBulk(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const startedAt = new Date().toISOString();

  console.log('Finlex Bulk Ingestion');
  console.log(`  fromYear: ${options.fromYear ?? 'all'}`);
  console.log(`  toYear:   ${options.toYear ?? 'all'}`);
  console.log(`  limit:    ${options.limit ?? 'none'}`);
  console.log(`  resume:   ${options.resume ? 'yes' : 'no'}`);
  console.log('');

  const entries = await loadListEntries(options);
  const allCandidates = selectCandidates(entries);
  const selected = selectCandidates(entries, options.limit);

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeManifest(selected);

  const report: IngestionReport = {
    started_at: startedAt,
    finished_at: startedAt,
    options,
    list_entries: entries.length,
    unique_candidates: allCandidates.length,
    selected_candidates: selected.length,
    ingested: 0,
    skipped_existing: 0,
    failed: 0,
    failures: [],
  };

  console.log(`List entries loaded:      ${entries.length}`);
  console.log(`Unique statute candidates: ${allCandidates.length}`);
  console.log(`Selected for ingestion:    ${selected.length}`);
  console.log('');

  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];
    const outputPath = outputPathFor(candidate);

    if (options.resume && fs.existsSync(outputPath)) {
      report.skipped_existing += 1;
      if ((i + 1) % 50 === 0) {
        console.log(`[${i + 1}/${selected.length}] resume-skip ${candidate.canonical_id}`);
      }
      continue;
    }

    console.log(`[${i + 1}/${selected.length}] ingest ${candidate.canonical_id} (source ${candidate.number_token})`);
    try {
      await ingestFinlexStatute(candidate.canonical_id, outputPath, {
        fetchNumberToken: candidate.number_token,
        canonicalStatuteId: candidate.canonical_id,
      });
      report.ingested += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed += 1;
      report.failures.push({
        statute_id: candidate.canonical_id,
        number_token: candidate.number_token,
        reason: message,
      });
      console.error(`  ERROR: ${message}`);

      if (/HTTP 429/u.test(message)) {
        report.aborted_reason = `rate_limited_at_${candidate.canonical_id}`;
        console.error('  Aborting run due to Finlex rate limiting.');
        break;
      }
    }

    await delay(REQUEST_DELAY_MS);
  }

  report.finished_at = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');

  console.log('');
  console.log('Bulk ingestion summary');
  console.log(`  Ingested:        ${report.ingested}`);
  console.log(`  Skipped existing:${report.skipped_existing}`);
  console.log(`  Failed:          ${report.failed}`);
  if (report.aborted_reason) {
    console.log(`  Aborted reason:  ${report.aborted_reason}`);
  }
  console.log(`  Report:          ${REPORT_PATH}`);
  console.log(`  Manifest:        ${MANIFEST_PATH}`);

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
