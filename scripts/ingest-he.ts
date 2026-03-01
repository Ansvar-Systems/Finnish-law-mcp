#!/usr/bin/env tsx
/**
 * Finnish Government Proposals (Hallituksen esitykset / HE) Ingestion Script
 *
 * Fetches Finnish government proposals from the Finlex Open Data REST API
 * and inserts them into the Finnish Law MCP premium database.
 *
 * Coverage: ~4,200+ government proposals (HE) from 1992 to present.
 * Each HE is linked to the statutes it affects via finlex:affects metadata.
 *
 * Data source: https://opendata.finlex.fi/finlex/avoindata/v1
 * Document type: government-proposal
 * Format: Akoma Ntoso XML (AKN)
 * License: CC-BY 4.0 (Oikeusministerio / Ministry of Justice)
 *
 * Tables populated:
 *   - legal_documents (type='bill')       -- one row per HE
 *   - preparatory_works                   -- links HE -> affected statutes
 *   - preparatory_works_full (premium)    -- full structured text
 *
 * Usage:
 *   npm run ingest:he                                  # All years (1992-present)
 *   npm run ingest:he -- --start-year 2020             # From 2020 onwards
 *   npm run ingest:he -- --end-year 2023               # Up to 2023
 *   npm run ingest:he -- --limit 50                    # First 50 documents
 *   npm run ingest:he -- --resume                      # Skip existing documents
 *   npm run ingest:he -- --dry-run                     # Enumerate without DB writes
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Database from '@ansvar/mcp-sqlite';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FINLEX_BASE = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/doc';
const USER_AGENT = 'Finnish-Law-MCP/1.2.3 (https://github.com/Ansvar-Systems/finnish-law-mcp)';
const REQUEST_DELAY_MS = 300;
const MAX_RETRIES = 4;
const PAGE_SIZE = 10; // Finlex API maximum

const DB_PATH = path.resolve(__dirname, '../data/database.db');
const CACHE_DIR = path.resolve(__dirname, '../data/source/finlex-he');
const LOG_DIR = path.resolve(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'ingest-he.log');

// Earliest year with HE data in Finlex
const EARLIEST_YEAR = 1992;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListItem {
  akn_uri: string;
  status: string;
}

interface SectionSummary {
  heading: string;
  text: string;
}

interface ParsedHE {
  document_id: string;           // "HE 1/2024"
  title: string;
  date_issued: string | null;
  year: number;
  number: string;
  ministry: string | null;
  state: string | null;          // "closed" | "pending"
  summary: string;               // Introduction section text
  full_text: string;             // All sections combined
  section_summaries: string | null; // JSON array of { heading, text }
  affected_statutes: string[];   // Statute IDs ("577/2005") this HE affects
  url: string;                   // Finlex URL
}

interface IngestionStats {
  pages_fetched: number;
  listed: number;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  links_created: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(message);
  ensureDir(LOG_DIR);
  fs.appendFileSync(LOG_FILE, `[${ts}] ${message}\n`);
}

function logError(message: string, error?: Error): void {
  const details = error ? ` -- ${error.message}` : '';
  const ts = new Date().toISOString();
  console.error(`ERROR: ${message}${details}`);
  ensureDir(LOG_DIR);
  fs.appendFileSync(LOG_FILE, `[${ts}] ERROR: ${message}${details}\n`);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, accept = 'application/xml'): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await delay(REQUEST_DELAY_MS * attempt * 2);
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
      });
      if (resp.status === 404) return null;
      if (resp.status === 429) {
        log(`  Rate limited -- waiting 10s...`);
        await delay(10_000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return await resp.text();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) {
        logError(`Fetch failed: ${url}`, err as Error);
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// API: Enumerate HE documents via /list endpoint
// ---------------------------------------------------------------------------

/**
 * Paginate through the Finlex /list endpoint for government-proposal documents.
 * The API returns max PAGE_SIZE (10) results per page. We iterate year-by-year
 * to keep memory bounded and stop when two consecutive empty pages are returned.
 */
async function listHEDocuments(
  startYear: number,
  endYear: number,
  stats: IngestionStats,
): Promise<ListItem[]> {
  const items: ListItem[] = [];
  const seen = new Set<string>();

  for (let year = startYear; year <= endYear; year++) {
    let page = 1;
    let consecutiveEmpty = 0;

    while (true) {
      const url =
        `${FINLEX_BASE}/government-proposal/list` +
        `?format=json&startYear=${year}&endYear=${year}` +
        `&langAndVersion=fin@&page=${page}&limit=${PAGE_SIZE}&sortBy=number`;

      const text = await fetchWithRetry(url, 'application/json');
      stats.pages_fetched++;

      if (!text) {
        consecutiveEmpty++;
        break;
      }

      let parsed: ListItem[];
      try {
        parsed = JSON.parse(text);
      } catch {
        logError(`Malformed JSON: government-proposal year=${year} page=${page}`);
        break;
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
        page++;
        await delay(REQUEST_DELAY_MS);
        continue;
      }

      consecutiveEmpty = 0;

      // Deduplicate -- Finnish only, skip Swedish versions
      for (const item of parsed) {
        if (!item.akn_uri.includes('/swe@') && !seen.has(item.akn_uri)) {
          seen.add(item.akn_uri);
          items.push(item);
        }
      }

      if (parsed.length < PAGE_SIZE) break; // Last page
      page++;
      await delay(REQUEST_DELAY_MS);
    }

    if (items.length > 0 && items.length % 100 < PAGE_SIZE) {
      log(`  Enumerated year ${year}: ${items.length} total so far`);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

/**
 * Parse year/number from an AKN list URI.
 * URI format: .../government-proposal/{year}/{number}/fin@
 */
function parseListUri(uri: string): { year: string; number: string } | null {
  const cleaned = uri
    .replace(/\/(fin|swe)@$/, '')
    .replace(/^.*\/government-proposal\//, '');

  const parts = cleaned.split('/');
  if (parts.length < 2) return null;

  const year = parts[parts.length - 2];
  const number = parts[parts.length - 1];

  if (!/^\d{4}$/.test(year)) return null;
  return { year, number };
}

// ---------------------------------------------------------------------------
// Fetch + cache single HE XML
// ---------------------------------------------------------------------------

async function fetchHEXml(year: string, number: string): Promise<string | null> {
  const cachePath = path.join(CACHE_DIR, `${year}_${number}_fin.xml`);

  // Use disk cache if available
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8');
  }

  const url = `${FINLEX_BASE}/government-proposal/${year}/${number}/fin@`;
  const xml = await fetchWithRetry(url);

  if (xml) {
    ensureDir(path.dirname(cachePath));
    fs.writeFileSync(cachePath, xml, 'utf-8');
  }

  return xml;
}

// ---------------------------------------------------------------------------
// AKN XML Parsing
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['hcontainer', 'tblock', 'p', 'akomaNtoso', 'FRBRalias', 'TLCOrganization'].includes(name),
});

/** Recursively extract plain text from a parsed AKN XML node. */
function extractText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node['#text'] != null) return String(node['#text']);
  if (Array.isArray(node)) return node.map(extractText).join(' ');

  let text = '';
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    text += extractText(node[key]) + ' ';
  }
  return text.trim();
}

/** Extract and normalize a section into a single text block. */
function extractSection(node: any): string {
  return extractText(node).replace(/\s+/g, ' ').trim();
}

/**
 * Parse statute number from AKN URI.
 * URI format: /akn/fi/act/statute-consolidated/{year}/{number}
 * Returns: "{number}/{year}" (Finnish statute number format, e.g. "577/2005")
 */
function parseStatuteRef(uri: string): string | null {
  const match = uri.match(/\/akn\/fi\/act\/[^/]+\/(\d{4})\/(\d+)/);
  if (!match) return null;
  return `${match[2]}/${match[1]}`;
}

/**
 * Parse an Akoma Ntoso HE document into a structured object.
 * Handles two wrapper formats:
 *   1. <AknXmlList><Results><akomaNtoso>... (single-document fetch response)
 *   2. <akomaNtoso>... (standalone)
 *
 * HE documents use <doc> (not <judgment> or <act>).
 */
function parseHEDocument(xml: string, year: string, number: string): ParsedHE | null {
  try {
    const doc = xmlParser.parse(xml);

    // Navigate to the document element
    let docEl: any;
    if (doc.AknXmlList?.Results?.akomaNtoso) {
      const akn = Array.isArray(doc.AknXmlList.Results.akomaNtoso)
        ? doc.AknXmlList.Results.akomaNtoso[0]
        : doc.AknXmlList.Results.akomaNtoso;
      docEl = akn?.doc || akn?.act || akn?.bill;
    } else if (doc.akomaNtoso) {
      const akn = Array.isArray(doc.akomaNtoso) ? doc.akomaNtoso[0] : doc.akomaNtoso;
      docEl = akn?.doc || akn?.act || akn?.bill;
    }

    if (!docEl) return null;

    const meta = docEl.meta;
    const frbrWork = meta?.identification?.FRBRWork;

    // -- Date issued --
    const dateIssued: string | null = frbrWork?.FRBRdate?.['@_date'] || null;

    // -- Ministry and state from <proprietary> --
    const proprietary = meta?.proprietary;
    let ministry: string | null = null;
    let state: string | null = null;

    if (proprietary) {
      const branch = proprietary['finlex:administrativeBranch'];
      if (branch) {
        // Can be a string or an element with @_refersTo
        if (typeof branch === 'string') {
          ministry = branch;
        } else {
          const refersTo = branch['@_refersTo'];
          ministry = refersTo
            ? refersTo.replace(/^#fi\./, '').replace(/-/g, ' ')
            : extractText(branch);
        }
      }

      const st = proprietary['finlex:state'];
      if (st) {
        state = typeof st === 'string' ? st : (st['@_value'] || extractText(st));
      }
    }

    // -- Affected statutes from <finlex:affects> metadata --
    const affectedStatuteSet = new Set<string>();
    if (proprietary) {
      const affects = proprietary['finlex:affects'];
      if (affects) {
        const affectsList = Array.isArray(affects) ? affects : [affects];
        for (const a of affectsList) {
          const href = a?.['@_href'] || a;
          if (typeof href === 'string') {
            const statuteId = parseStatuteRef(href);
            if (statuteId) affectedStatuteSet.add(statuteId);
          }
        }
      }
    }

    // -- Also extract statute refs from <ref href="/akn/fi/act/..."> in body --
    const refPattern = /href="(\/akn\/fi\/act\/[^"]+)"/g;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refPattern.exec(xml)) !== null) {
      const statuteId = parseStatuteRef(refMatch[1]);
      if (statuteId) affectedStatuteSet.add(statuteId);
    }
    const affectedStatutes = [...affectedStatuteSet];

    // -- Title from <preface> --
    // Finlex wraps docNumber and docTitle in a single <p> element:
    //   <preface><p><docNumber>HE 1/2024</docNumber><docTitle>...</docTitle></p></preface>
    let title = '';
    const preface = docEl.preface;
    if (preface) {
      const firstP = Array.isArray(preface.p) ? preface.p[0] : preface.p;
      const docNumber = firstP?.docNumber || preface.docNumber;
      const docTitle = firstP?.docTitle || preface.p?.[1]?.docTitle || preface.docTitle;
      const numText = extractText(docNumber);
      const titleText = extractText(docTitle);
      title = titleText ? `${numText}: ${titleText}` : numText;
    }
    if (!title) title = `HE ${number}/${year}`;

    // -- Body sections from <mainBody> --
    const mainBody = docEl.mainBody || docEl.body;
    let summary = '';
    const fullTextParts: string[] = [];
    const sectionSummaries: SectionSummary[] = [];

    if (mainBody) {
      const containers = mainBody.hcontainer || [];
      const containerList = Array.isArray(containers) ? containers : [containers];

      for (const container of containerList) {
        const name = container['@_name'] || '';
        const sectionText = extractSection(container);

        if (sectionText) {
          fullTextParts.push(sectionText);

          // The introduction section ("ESITYKSEN PAASIALLINEN SISALTO") is the summary
          if (name === 'introduction' && !summary) {
            summary = sectionText;
          }

          // Extract heading for section summaries
          const heading = container.heading ? extractText(container.heading) : name;
          if (heading && sectionText.length > 0) {
            sectionSummaries.push({
              heading,
              text: sectionText.length > 500
                ? sectionText.substring(0, 497) + '...'
                : sectionText,
            });
          }
        }

        // Process nested tblocks within containers
        const tblocks = container.tblock;
        if (tblocks) {
          const tbList = Array.isArray(tblocks) ? tblocks : [tblocks];
          for (const tb of tbList) {
            const tbText = extractSection(tb);
            if (tbText) {
              fullTextParts.push(tbText);
              const tbHeading = tb.heading ? extractText(tb.heading) : '';
              if (tbHeading) {
                sectionSummaries.push({
                  heading: tbHeading,
                  text: tbText.length > 500
                    ? tbText.substring(0, 497) + '...'
                    : tbText,
                });
              }
            }
          }
        }
      }
    }

    if (!summary) summary = title;
    const fullText = fullTextParts.join('\n\n');

    const documentId = `HE ${number}/${year}`;
    const finlexUrl = `https://finlex.fi/fi/esitykset/he/${year}/${number}`;

    return {
      document_id: documentId,
      title,
      date_issued: dateIssued,
      year: parseInt(year),
      number,
      ministry,
      state,
      summary,
      full_text: fullText,
      section_summaries: sectionSummaries.length > 0 ? JSON.stringify(sectionSummaries) : null,
      affected_statutes: affectedStatutes,
      url: finlexUrl,
    };
  } catch (err) {
    logError(`XML parse error for HE ${number}/${year}`, err as Error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Run 'npm run build:db' first.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

interface DbStatements {
  checkDoc: Database.Statement;
  insertDoc: Database.Statement;
  updateDoc: Database.Statement;
  insertPrepWork: Database.Statement;
  checkStatute: Database.Statement;
  getPrepWorkId: Database.Statement;
  upsertPrepFull: Database.Statement | null;
}

function prepareStatements(db: Database.Database): DbStatements {
  const hasFull = tableExists(db, 'preparatory_works_full');

  return {
    checkDoc: db.prepare('SELECT id FROM legal_documents WHERE id = ?'),

    insertDoc: db.prepare(`
      INSERT INTO legal_documents
        (id, type, title, title_en, short_name, status, issued_date, in_force_date, url, description)
      VALUES (?, 'bill', ?, NULL, NULL, 'in_force', ?, NULL, ?, NULL)
    `),

    updateDoc: db.prepare(`
      UPDATE legal_documents
      SET title = ?, issued_date = ?, url = ?, last_updated = datetime('now')
      WHERE id = ?
    `),

    // Links an HE to the statutes it affects
    insertPrepWork: db.prepare(`
      INSERT OR IGNORE INTO preparatory_works
        (statute_id, prep_document_id, title, summary)
      VALUES (?, ?, ?, ?)
    `),

    checkStatute: db.prepare(`
      SELECT id FROM legal_documents WHERE id = ? AND type = 'statute'
    `),

    getPrepWorkId: db.prepare(`
      SELECT id FROM preparatory_works WHERE statute_id = ? AND prep_document_id = ?
    `),

    upsertPrepFull: hasFull
      ? db.prepare(`
          INSERT INTO preparatory_works_full (prep_work_id, full_text, section_summaries)
          VALUES (?, ?, ?)
          ON CONFLICT(prep_work_id) DO UPDATE SET
            full_text = excluded.full_text,
            section_summaries = excluded.section_summaries
        `)
      : null,
  };
}

/**
 * Insert or update a single HE document and its statute links.
 *
 * Flow:
 *   1. Insert/update the HE in legal_documents (type='bill')
 *   2. For each affected statute found in the DB, create a preparatory_works link
 *   3. If preparatory_works_full exists (premium), store full text
 */
function insertHE(
  db: Database.Database,
  he: ParsedHE,
  stmts: DbStatements,
  resume: boolean,
  stats: IngestionStats,
): 'inserted' | 'updated' | 'skipped' {
  const existing = stmts.checkDoc.get(he.document_id);

  if (existing && resume) return 'skipped';

  if (existing) {
    stmts.updateDoc.run(he.title, he.date_issued, he.url, he.document_id);
  } else {
    stmts.insertDoc.run(he.document_id, he.title, he.date_issued, he.url);
  }

  // Link to affected statutes
  for (const statuteRef of he.affected_statutes) {
    const statuteExists = stmts.checkStatute.get(statuteRef);
    if (!statuteExists) continue;

    stmts.insertPrepWork.run(
      statuteRef,
      he.document_id,
      he.title,
      he.summary.length > 1000 ? he.summary.substring(0, 997) + '...' : he.summary,
    );
    stats.links_created++;

    // Populate full text in premium table
    if (stmts.upsertPrepFull && he.full_text) {
      const pwRow = stmts.getPrepWorkId.get(statuteRef, he.document_id) as
        | { id: number }
        | undefined;
      if (pwRow) {
        stmts.upsertPrepFull.run(pwRow.id, he.full_text, he.section_summaries);
      }
    }
  }

  return existing ? 'updated' : 'inserted';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  startYear: number;
  endYear: number;
  limit?: number;
  resume: boolean;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const currentYear = new Date().getFullYear();
  const opts: CliOptions = {
    startYear: EARLIEST_YEAR,
    endYear: currentYear,
    resume: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start-year':
        opts.startYear = parseInt(args[++i]);
        break;
      case '--end-year':
        opts.endYear = parseInt(args[++i]);
        break;
      case '--limit':
        opts.limit = parseInt(args[++i]);
        break;
      case '--resume':
        opts.resume = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  log('');
  log('Finnish Government Proposals (HE) Ingestion');
  log('='.repeat(63));
  log(`  Database:   ${DB_PATH}`);
  log(`  Cache:      ${CACHE_DIR}`);
  log(`  Years:      ${opts.startYear}--${opts.endYear}`);
  if (opts.limit) log(`  Limit:      ${opts.limit}`);
  if (opts.resume) log(`  Resume:     ON`);
  if (opts.dryRun) log(`  Dry run:    ON`);
  log('');

  let db: Database.Database | null = null;
  let stmts: DbStatements | null = null;

  if (!opts.dryRun) {
    db = openDb();
    stmts = prepareStatements(db);
    const hasFull = stmts.upsertPrepFull !== null;
    log(`  preparatory_works_full table: ${hasFull ? 'present (premium)' : 'absent (free tier)'}`);
    log('');
  }

  const stats: IngestionStats = {
    pages_fetched: 0,
    listed: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    links_created: 0,
  };

  let totalProcessed = 0;

  try {
    // Step 1: Enumerate HE documents via /list endpoint
    log('Enumerating HE documents from Finlex...');
    const items = await listHEDocuments(opts.startYear, opts.endYear, stats);
    stats.listed = items.length;
    log(`Found ${items.length} HE documents (${opts.startYear}--${opts.endYear})`);
    log('');

    // Step 2: Fetch XML, parse, insert
    for (let i = 0; i < items.length; i++) {
      if (opts.limit && totalProcessed >= opts.limit) break;

      const parsed = parseListUri(items[i].akn_uri);
      if (!parsed) {
        stats.failed++;
        totalProcessed++;
        continue;
      }

      const expectedId = `HE ${parsed.number}/${parsed.year}`;

      // Resume check: skip if already in DB
      if (opts.resume && db) {
        const existing = stmts!.checkDoc.get(expectedId);
        if (existing) {
          stats.skipped++;
          totalProcessed++;
          continue;
        }
      }

      if (opts.dryRun) {
        if (i < 5 || i === items.length - 1) {
          log(`  [DRY] ${expectedId}`);
        } else if (i === 5) {
          log(`  [DRY] ... (${items.length - 6} more)`);
        }
        totalProcessed++;
        continue;
      }

      // Fetch XML (disk-cached)
      const xml = await fetchHEXml(parsed.year, parsed.number);
      if (!xml) {
        stats.failed++;
        totalProcessed++;
        continue;
      }
      stats.fetched++;

      // Parse AKN XML
      const heData = parseHEDocument(xml, parsed.year, parsed.number);
      if (!heData) {
        stats.failed++;
        totalProcessed++;
        continue;
      }

      // Insert into DB inside a transaction
      try {
        const txn = db!.transaction(() =>
          insertHE(db!, heData, stmts!, opts.resume, stats),
        );
        const result = txn();
        if (result === 'inserted') stats.inserted++;
        else if (result === 'updated') stats.updated++;
        else stats.skipped++;
      } catch (err) {
        stats.failed++;
        logError(`DB error: ${heData.document_id}`, err as Error);
      }

      totalProcessed++;

      // Progress every 100 documents
      if (totalProcessed % 100 === 0) {
        log(
          `  [${totalProcessed}/${stats.listed}] ` +
          `in=${stats.inserted} up=${stats.updated} skip=${stats.skipped} ` +
          `fail=${stats.failed} links=${stats.links_created}`,
        );
      }

      await delay(REQUEST_DELAY_MS);
    }

    // Finalize
    if (db) {
      log('Optimizing database...');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('ANALYZE');
    }
  } finally {
    db?.close();
  }

  // Summary
  log('');
  log('='.repeat(63));
  log('Finnish HE Ingestion -- Complete');
  log('='.repeat(63));
  log(`  HE listed:             ${stats.listed}`);
  log(`  HE fetched (XML):      ${stats.fetched}`);
  log(`  Inserted:              ${stats.inserted}`);
  log(`  Updated:               ${stats.updated}`);
  log(`  Skipped (existing):    ${stats.skipped}`);
  log(`  Failed:                ${stats.failed}`);
  log(`  Statute links created: ${stats.links_created}`);
  log('='.repeat(63));
  log(`  Cache: ${CACHE_DIR}`);
  log(`  Log:   ${LOG_FILE}`);
  log('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  main().catch((err) => {
    logError('Ingestion failed', err);
    process.exit(1);
  });
}
