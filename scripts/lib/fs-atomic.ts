/**
 * Atomic file writes for acquisition outputs (seeds, caches, reports).
 *
 * A plain writeFileSync interrupted by SIGKILL/OOM/ENOSPC leaves a truncated
 * file in place — for seed files that masquerades as "unstamped, self-heal",
 * and for cached source XML it is a STICKY failure (the corrupt cache is
 * trusted on every later run). tmp-file + rename makes the swap atomic on
 * POSIX: readers see either the old complete file or the new complete file.
 */

import * as fs from 'fs';
import * as path from 'path';

export function writeFileAtomicSync(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // Never leave tmp litter behind on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file never created / already renamed — nothing to clean.
    }
    throw error;
  }
}
