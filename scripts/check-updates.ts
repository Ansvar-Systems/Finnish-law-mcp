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
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { FINLEX_REQUEST_DELAY_MS, FINLEX_USER_AGENT } from './lib/finlex-http.js';
import { compareVersionNumbers, stampedVersionOf } from './lib/finlex-version.js';

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

/** Parse '/act/statute-consolidated/{year}/{number}/fin@{version}' into id + version token. */
function parseConsolidatedAknUri(uri: string | undefined): { id: string; version: string } | null {
  if (!uri) return null;
  const match = uri.match(/\/act\/statute-consolidated\/(\d{4})\/(\d+)(?:-\d+)?\/fin@([0-9a-zA-Z]*)$/u);
  if (!match) return null;
  return { id: `${match[2]}/${match[1]}`, version: match[3] };
}

function newerVersion(current: string | undefined, incoming: string): string {
  if (!current) return incoming;
  // Bare '@' (empty token) is the enactment-dated expression — any dated
  // token outranks it.
  if (!/^\d{8}$/u.test(incoming)) return current;
  if (!/^\d{8}$/u.test(current)) return incoming;
  return compareVersionNumbers(incoming, current) > 0 ? incoming : current;
}

/** Newest consolidation version token per statute id, for one work year. */
async function fetchNewestVersionsForYear(year: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();

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

    for (const entry of entries) {
      const parsed = parseConsolidatedAknUri(entry.akn_uri);
      if (!parsed) continue;
      versions.set(parsed.id, newerVersion(versions.get(parsed.id), parsed.version));
    }

    if (entries.length < PAGE_LIMIT) {
      break;
    }
    if (page === MAX_PAGES_PER_YEAR) {
      // Never silently truncate: a partial list would mask updates.
      throw new Error(`year ${year}: consolidated list exceeds ${MAX_PAGES_PER_YEAR} pages — raise the cap`);
    }

    await delay(REQUEST_DELAY_MS);
  }

  return versions;
}

function stampFor(statuteId: string): string | null {
  const safe = toFinnishStatuteId(statuteId).replace('/', '_');
  const seedPath = path.join(SEED_DIR, `${safe}.json`);
  if (!fs.existsSync(seedPath)) return null;
  try {
    return stampedVersionOf(JSON.parse(fs.readFileSync(seedPath, 'utf-8')));
  } catch {
    return null;
  }
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
    const stamped = stampFor(doc.id);
    const remote = remoteVersions.get(finlexId) ?? null;

    if (!stamped) {
      results.push({
        id: doc.id,
        title: doc.title,
        stamped_version: null,
        remote_version: remote,
        has_update: true,
        error: 'No consolidation stamp — freshness unprovable, re-ingest (self-heal)',
      });
      continue;
    }

    if (!remote || !/^\d{8}$/u.test(remote)) {
      // No consolidated work upstream: the as-enacted original is the current
      // text. The stamp records which expression we hold; nothing to compare.
      results.push({
        id: doc.id,
        title: doc.title,
        stamped_version: stamped,
        remote_version: remote,
        has_update: false,
      });
      continue;
    }

    const hasUpdate = !/^\d{8}$/u.test(stamped) || compareVersionNumbers(remote, stamped) > 0;
    results.push({
      id: doc.id,
      title: doc.title,
      stamped_version: stamped,
      remote_version: remote,
      has_update: hasUpdate,
    });
  }

  console.log('');
  for (const result of results) {
    process.stdout.write(`  ${result.id} (${result.title.substring(0, 48)})... `);
    if (result.error) {
      console.log(`needs re-ingest: ${result.error}`);
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

checkUpdates().catch(error => {
  console.error('Check failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
