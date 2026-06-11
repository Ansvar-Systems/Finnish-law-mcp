/**
 * Legacy Swedish-template writers guard (PR #79 round-2, FORCE_LEGACY_INGEST
 * pattern): auto-ingest-all-statutes.ts and ingest-relevant-laws.ts import
 * the Riksdagen (SWEDISH parliament) ingest and write UNSTAMPED seeds
 * straight into data/seed/, bypassing the version-stamped Finlex acquisition.
 * They must refuse to run unless explicitly forced.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runScript(script: string): { status: number | null; stderr: string } {
  const env = { ...process.env };
  delete env.FORCE_LEGACY_INGEST;
  const result = spawnSync('node', ['--import', 'tsx', script, '--dry-run'], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('legacy Riksdagen seed writers refuse to run without FORCE_LEGACY_INGEST', () => {
  it('auto-ingest-all-statutes.ts exits non-zero with an explanation', () => {
    const { status, stderr } = runScript('scripts/auto-ingest-all-statutes.ts');
    expect(status).toBe(2);
    expect(stderr).toContain('FORCE_LEGACY_INGEST');
    expect(stderr).toMatch(/legacy/iu);
  }, 60_000);

  it('ingest-relevant-laws.ts exits non-zero with an explanation', () => {
    const { status, stderr } = runScript('scripts/ingest-relevant-laws.ts');
    expect(status).toBe(2);
    expect(stderr).toContain('FORCE_LEGACY_INGEST');
  }, 60_000);
});
