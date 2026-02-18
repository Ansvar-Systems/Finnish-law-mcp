# Production Audit Fix Design

**Date:** 2026-02-18
**Audit Standard:** MCP Server Production Audit v1.0 (Ansvar Systems)
**Server:** Finnish Law MCP (`@ansvar/finnish-law-mcp`)

## Context

A prior worktree (`claude/great-varahamihira`) contains uncommitted fixes:
- Finnish localization across 27 files (Swedish terminology replaced)
- New `list_sources` tool (`src/tools/list-sources.ts`)
- `get_provision_at_date` registration in both index.ts and registry.ts
- Version bump 1.2.2 → 1.2.3 across config files

This work is recovered and extended to address all remaining audit findings.

## Audit Findings Summary

### FAILs (6)
1. `list_sources` tool missing on main — **fixed in worktree**
2. Tool descriptions lack "when NOT to use" guidance
3. `db_metadata` missing `jurisdiction` field
4. `test-db.ts` fixture uses Swedish data, not Finnish
5. WAL journal mode in build scripts (breaks serverless)
6. `server.json` version mismatch — **fixed in worktree**

### WARNINGs (5)
1. No JSON Schema `minimum`/`maximum` on limit params
2. `sources.yml` missing EUR-Lex entry
3. `golden-hashes.json` has placeholder hashes
4. Health endpoint version lag — **fixed in worktree**
5. `better-sqlite3` in build scripts (acceptable — devDependency only)

## Fix Plan

### Phase A: Recover worktree changes
- Create feature branch `fix/production-audit`
- Cherry-pick/apply all worktree changes
- Commit as "fix: recover Finnish localization and list_sources tool"

### Phase B: Fix remaining FAILs

#### B1. Tool descriptions — add "when NOT to use"
**Files:** `src/index.ts`, `src/tools/registry.ts`
- Add disambiguation guidance to tool descriptions
- Key pairs: `search_legislation` vs `get_provision`, `get_eu_basis` vs `get_provision_eu_basis`

#### B2. db_metadata jurisdiction
**File:** `scripts/build-db.ts`
- Add `jurisdiction: 'FI'` to db_metadata inserts

#### B3. Finnish test fixtures
**File:** `tests/fixtures/test-db.ts`
- Replace Swedish SFS IDs with Finnish format (1050/2018)
- Replace Swedish statute titles/content with Finnish
- Replace Swedish court types (NJA, HFD) with Finnish (KKO, KHO)
- Replace Swedish bill format with Finnish (HE nn/yyyy vp)

#### B4. Journal mode WAL → DELETE
**Files:** `scripts/build-db.ts`, `scripts/build-db-paid.ts`, ingestion scripts
- Change `PRAGMA journal_mode = WAL` to `PRAGMA journal_mode = DELETE`

### Phase C: Fix WARNINGs

#### C1. JSON Schema constraints
**Files:** `src/index.ts`, `src/tools/registry.ts`
- Add `minimum: 1`, `maximum: 50` (or appropriate max) to all limit params
- Add `default` values where documented

#### C2. sources.yml EUR-Lex entry
**File:** `sources.yml`
- Add EUR-Lex as secondary source

#### C3. Golden hashes (if drift-detect script works)
**File:** `fixtures/golden-hashes.json`
- Compute real SHA256 hashes from current database

### Phase D: Verify
- Run full test suite
- Confirm 193+ tests pass
- Build TypeScript successfully

## Out of Scope
- Data sampling against Finlex (requires manual cross-referencing)
- Deploying to Vercel
- npm publishing
- Full rewrite of citation parser for Finnish format (existing parser works for current data)
