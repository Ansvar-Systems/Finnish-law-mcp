#!/usr/bin/env tsx
/**
 * Check for updates to ingested Finnish statutes.
 *
 * Uses Finlex open data list endpoints and compares remote per-statute status
 * (NEW/MODIFIED) against locally seeded statutes in data/database.db.
 *
 * Usage: npm run check-updates
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.db');

const FINLEX_LIST_URL = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute/list';
const USER_AGENT = 'Finnish-Law-MCP/1.2.2 (https://github.com/Ansvar-Systems/finnish-law-mcp)';
const REQUEST_DELAY_MS = 250;
const PAGE_LIMIT = 10; // Finlex list endpoint enforces max 10
const MAX_PAGES_PER_YEAR = 50;

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
  local_date: string | null;
  remote_status: string | null;
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

function parseFinnishIdFromAknUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const match = uri.match(/\/act\/statute\/(\d{4})\/(\d+)\/(?:fin|swe)@/u);
  if (!match) return null;
  return `${match[2]}/${match[1]}`;
}

function mergeStatus(current: string | undefined, next: string | undefined): string {
  const normalizedCurrent = (current ?? '').toUpperCase();
  const normalizedNext = (next ?? '').toUpperCase();
  if (normalizedCurrent === 'MODIFIED' || normalizedNext === 'MODIFIED') {
    return 'MODIFIED';
  }
  if (normalizedCurrent === 'NEW' || normalizedNext === 'NEW') {
    return 'NEW';
  }
  return normalizedNext || normalizedCurrent || 'UNKNOWN';
}

async function fetchRemoteStatusesForYear(year: string): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();

  for (let page = 1; page <= MAX_PAGES_PER_YEAR; page++) {
    const params = new URLSearchParams({
      format: 'json',
      page: String(page),
      limit: String(PAGE_LIMIT),
      sortBy: 'dateIssued',
      startYear: year,
      endYear: year,
      LangAndVersion: 'fin@',
      typeStatute: 'act',
    });

    const url = `${FINLEX_LIST_URL}?${params.toString()}`;
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
      const statuteId = parseFinnishIdFromAknUri(entry.akn_uri);
      if (!statuteId) continue;

      const existing = statuses.get(statuteId);
      statuses.set(statuteId, mergeStatus(existing, entry.status));
    }

    if (entries.length < PAGE_LIMIT) {
      break;
    }

    await delay(REQUEST_DELAY_MS);
  }

  return statuses;
}

async function checkUpdates(): Promise<void> {
  console.log('Finnish Law MCP - Update Checker');
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

  const remoteStatuses = new Map<string, string>();
  const remoteFetchErrors: string[] = [];

  for (const year of years) {
    try {
      process.stdout.write(`  Loading Finlex list for ${year}... `);
      const byYear = await fetchRemoteStatusesForYear(year);
      for (const [id, status] of byYear) {
        remoteStatuses.set(id, mergeStatus(remoteStatuses.get(id), status));
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
    const remoteStatus = remoteStatuses.get(finlexId) ?? null;
    const hasUpdate = remoteStatus === 'MODIFIED';

    if (!remoteStatus) {
      results.push({
        id: doc.id,
        title: doc.title,
        local_date: doc.last_updated,
        remote_status: null,
        has_update: false,
        error: 'Not found in Finlex list results',
      });
      continue;
    }

    results.push({
      id: doc.id,
      title: doc.title,
      local_date: doc.last_updated,
      remote_status: remoteStatus,
      has_update: hasUpdate,
    });
  }

  console.log('');
  for (const result of results) {
    process.stdout.write(`  ${result.id} (${result.title.substring(0, 48)})... `);
    if (result.error) {
      console.log(`error: ${result.error}`);
    } else if (result.has_update) {
      console.log('UPDATE AVAILABLE');
    } else {
      console.log(`up to date (${result.remote_status})`);
    }
  }

  const updates = results.filter(r => r.has_update);
  const errors = [...remoteFetchErrors, ...results.filter(r => r.error).map(r => `${r.id}: ${r.error}`)];
  const current = results.filter(r => !r.has_update && !r.error);

  console.log('');
  console.log(`Up to date: ${current.length}`);
  console.log(`Updates:    ${updates.length}`);
  console.log(`Errors:     ${errors.length}`);

  if (updates.length > 0) {
    console.log('');
    console.log('To re-ingest updated statutes:');
    for (const u of updates) {
      const safeId = toFinnishStatuteId(u.id).replace('/', '_');
      console.log(`  npm run ingest -- ${toFinnishStatuteId(u.id)} data/seed/${safeId}.json`);
    }
    console.log('  npm run build:db');
    process.exit(1);
  }
}

checkUpdates().catch(error => {
  console.error('Check failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
