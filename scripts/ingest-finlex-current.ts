#!/usr/bin/env tsx
/**
 * Default "current statutes" ingestion entrypoint.
 *
 * Delegates to the bulk Finlex ingestor and enables --resume by default
 * so re-runs are incremental over existing seed files.
 */

import { pathToFileURL } from 'url';
import { ingestFinlexBulk } from './ingest-finlex-bulk.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hasResume = args.includes('--resume');
  const effectiveArgs = hasResume ? args : ['--resume', ...args];

  await ingestFinlexBulk(effectiveArgs);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Current statute ingestion failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
