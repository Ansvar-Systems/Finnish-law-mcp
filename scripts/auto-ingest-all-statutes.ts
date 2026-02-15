#!/usr/bin/env tsx
/**
 * Automated Bulk Ingestion of Swedish Statutes
 *
 * Fetches ALL SFS documents from Riksdagen API, filters for major laws,
 * and automatically ingests them into the database.
 *
 * Strategy:
 * 1. Fetch SFS list from Riksdagen API (all ~11,413 documents)
 * 2. Filter for major laws (heuristics: length, chapters, relevance indicators)
 * 3. Batch ingest with progress tracking
 * 4. Skip already-ingested statutes
 * 5. Generate completion report
 *
 * Usage:
 *   tsx scripts/auto-ingest-all-statutes.ts [--limit N] [--year-start YYYY] [--year-end YYYY]
 *
 * Examples:
 *   tsx scripts/auto-ingest-all-statutes.ts --limit 50
 *   tsx scripts/auto-ingest-all-statutes.ts --year-start 2000 --year-end 2024
 *   tsx scripts/auto-ingest-all-statutes.ts --dry-run
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ingest } from './ingest-riksdagen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RIKSDAGEN_LIST_URL = 'https://data.riksdagen.se/dokumentlista';
const OUTPUT_DIR = path.resolve(__dirname, '../data/seed');
const REQUEST_DELAY_MS = 600; // 0.6s to be respectful to API

interface CLIOptions {
  limit?: number;
  yearStart?: number;
  yearEnd?: number;
  dryRun: boolean;
  skipExisting: boolean;
}

interface SFSDocument {
  beteckning: string; // e.g., "2018:218"
  titel: string;
  datum: string;
  organ: string;
  summary?: string;
}

interface IngestionStats {
  total: number;
  skipped: number;
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    dryRun: false,
    skipExisting: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        break;
      case '--year-start':
        options.yearStart = parseInt(args[++i], 10);
        break;
      case '--year-end':
        options.yearEnd = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-skip':
        options.skipExisting = false;
        break;
    }
  }

  return options;
}

async function fetchAllSFSDocuments(options: CLIOptions): Promise<SFSDocument[]> {
  const documents: SFSDocument[] = [];
  let page = 1;
  let hasMore = true;

  console.log('Fetching SFS document list from Riksdagen API...\n');

  while (hasMore) {
    const yearFilter = options.yearStart && options.yearEnd
      ? `&utdatumfrom=${options.yearStart}-01-01&utdatumtom=${options.yearEnd}-12-31`
      : '';

    const url = `${RIKSDAGEN_LIST_URL}/?doktyp=sfs&format=json&p=${page}${yearFilter}`;

    try {
      const response = await fetch(url);
      const text = await response.text();

      // API returns XML even when format=json is specified
      // Parse the XML to extract document list
      const docs = parseRiksdagenXML(text);

      if (docs.length === 0) {
        hasMore = false;
      } else {
        documents.push(...docs);
        console.log(`Fetched page ${page}: ${docs.length} documents (total: ${documents.length})`);

        if (options.limit && documents.length >= options.limit) {
          hasMore = false;
        } else {
          page++;
          await sleep(REQUEST_DELAY_MS);
        }
      }
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error);
      hasMore = false;
    }
  }

  return documents.slice(0, options.limit);
}

function parseRiksdagenXML(xml: string): SFSDocument[] {
  const documents: SFSDocument[] = [];

  // Extract document blocks with regex (lightweight XML parsing)
  const docMatches = xml.matchAll(/<dokument>.*?<\/dokument>/gs);

  for (const match of docMatches) {
    const docXml = match[0];

    const beteckning = extractXMLTag(docXml, 'beteckning');
    const titel = extractXMLTag(docXml, 'titel');
    const datum = extractXMLTag(docXml, 'datum');
    const organ = extractXMLTag(docXml, 'organ');
    const summary = extractXMLTag(docXml, 'summary');

    if (beteckning && titel) {
      documents.push({
        beteckning,
        titel,
        datum: datum || '',
        organ: organ || '',
        summary,
      });
    }
  }

  return documents;
}

function extractXMLTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`, 's'));
  return match ? match[1].trim() : undefined;
}

function filterMajorLaws(documents: SFSDocument[]): SFSDocument[] {
  return documents.filter(doc => {
    // Filter out minor amendments and trivial ordinances

    // Exclude documents with "ändr" (amendment) or "upph" (repealed) in title
    if (doc.titel.match(/ändr|upph|ändring|upphävande|omtryck/i)) {
      return false;
    }

    // Exclude very short titles (likely trivial ordinances)
    if (doc.titel.length < 20) {
      return false;
    }

    // Exclude EU notifications/announcements
    if (doc.titel.match(/tillkännagivande|kungörelse/i)) {
      return false;
    }

    // Include only "lag" (law) documents and "balk" (codes), not standalone "förordning" (ordinance)
    // Exception: Keep constitutional ordinances (Tryckfrihetsförordningen, etc.)
    const isLaw = doc.titel.match(/\blag\b|\bbalken?\b/i);
    const isConstitutionalOrdinance = doc.titel.match(/tryckfrihetsförordningen|regeringsformen|successionsordningen|riksdagsordningen/i);

    if (!isLaw && !isConstitutionalOrdinance) {
      return false;
    }

    return true;
  });
}

function getExistingSeedFiles(): Set<string> {
  if (!fs.existsSync(OUTPUT_DIR)) {
    return new Set();
  }

  const files = fs.readdirSync(OUTPUT_DIR);
  const sfsNumbers = new Set<string>();

  for (const file of files) {
    if (file.endsWith('.json')) {
      // Convert filename back to SFS number (e.g., "2018_218.json" → "2018:218")
      const match = file.match(/(\d{4})[-_](\d+)\.json/);
      if (match) {
        sfsNumbers.add(`${match[1]}:${match[2]}`);
      }
    }
  }

  return sfsNumbers;
}

function safeFileName(sfsNumber: string): string {
  return sfsNumber.replace(':', '_');
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ingestBatch(
  documents: SFSDocument[],
  options: CLIOptions,
  existing: Set<string>
): Promise<IngestionStats> {
  const stats: IngestionStats = {
    total: documents.length,
    skipped: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`\nIngesting ${documents.length} statutes...\n`);

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const sfsNumber = doc.beteckning;

    // Skip if already exists
    if (options.skipExisting && existing.has(sfsNumber)) {
      console.log(`[${i + 1}/${documents.length}] SKIP ${sfsNumber} (already exists)`);
      stats.skipped++;
      continue;
    }

    const outputPath = path.join(OUTPUT_DIR, `${safeFileName(sfsNumber)}.json`);

    if (options.dryRun) {
      console.log(`[${i + 1}/${documents.length}] DRY RUN: Would ingest ${sfsNumber} - ${doc.titel}`);
      stats.succeeded++;
      continue;
    }

    try {
      await ingest(sfsNumber, outputPath);
      console.log(`[${i + 1}/${documents.length}] ✓ ${sfsNumber} - ${doc.titel.substring(0, 60)}...`);
      stats.succeeded++;
      await sleep(REQUEST_DELAY_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${i + 1}/${documents.length}] ✗ ${sfsNumber} - ${message}`);
      stats.failed++;
      stats.errors.push({ id: sfsNumber, error: message });
    }
  }

  return stats;
}

function printStats(stats: IngestionStats, options: CLIOptions): void {
  console.log('\n' + '='.repeat(70));
  console.log('INGESTION COMPLETE');
  console.log('='.repeat(70));
  console.log(`Total statutes processed: ${stats.total}`);
  console.log(`Skipped (already exist):  ${stats.skipped}`);
  console.log(`Successfully ingested:    ${stats.succeeded}`);
  console.log(`Failed:                   ${stats.failed}`);
  console.log('='.repeat(70));

  if (stats.failed > 0) {
    console.log('\nFailed ingestions:');
    for (const error of stats.errors) {
      console.log(`  - ${error.id}: ${error.error}`);
    }
  }

  if (options.dryRun) {
    console.log('\n[DRY RUN MODE - No files were actually created]');
  }
}

async function run(): Promise<void> {
  const options = parseArgs();

  console.log('Automated Swedish Law Ingestion');
  console.log('================================\n');
  console.log(`Year range: ${options.yearStart || 'all'} - ${options.yearEnd || 'all'}`);
  console.log(`Limit: ${options.limit || 'none'}`);
  console.log(`Dry run: ${options.dryRun ? 'YES' : 'NO'}`);
  console.log(`Skip existing: ${options.skipExisting ? 'YES' : 'NO'}\n`);

  // Step 1: Fetch all SFS documents
  const allDocuments = await fetchAllSFSDocuments(options);
  console.log(`\nTotal SFS documents fetched: ${allDocuments.length}\n`);

  // Step 2: Filter for major laws
  const majorLaws = filterMajorLaws(allDocuments);
  console.log(`Filtered to major laws: ${majorLaws.length}\n`);

  // Step 3: Get existing seed files
  const existing = getExistingSeedFiles();
  console.log(`Existing seed files: ${existing.size}\n`);

  // Step 4: Ingest batch
  const stats = await ingestBatch(majorLaws, options, existing);

  // Step 5: Print stats
  printStats(stats, options);

  if (!options.dryRun && stats.succeeded > 0) {
    console.log('\n✓ Run `npm run build:db` to rebuild database with new statutes');
  }
}

run().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
