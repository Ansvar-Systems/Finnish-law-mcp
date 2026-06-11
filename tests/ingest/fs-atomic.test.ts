import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../../scripts/lib/fs-atomic.js';

describe('writeFileAtomicSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-'));
  });

  it('writes content and leaves no tmp file behind', () => {
    const target = path.join(dir, 'nested', 'file.json');
    writeFileAtomicSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.json']);
  });

  it('replaces an existing file atomically (rename, not truncate-then-write)', () => {
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'old', 'utf-8');
    writeFileAtomicSync(target, 'new content');
    expect(fs.readFileSync(target, 'utf-8')).toBe('new content');
    expect(fs.readdirSync(dir)).toEqual(['file.txt']);
  });
});
