# Production Audit Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all FAIL and WARNING findings from the MCP Production Audit v1.0 for Finnish Law MCP.

**Architecture:** Recover uncommitted worktree changes (Finnish localization, list_sources tool, version bumps), then fix remaining audit items: Finnish test fixtures, WAL→DELETE journal mode, tool description improvements, JSON Schema constraints, and db_metadata jurisdiction.

**Tech Stack:** TypeScript, SQLite FTS5, MCP SDK, Vitest

---

### Task 1: Create feature branch and recover worktree changes

**Files:**
- All 27 modified files in worktree `claude/great-varahamihira`
- New file: `src/tools/list-sources.ts`

**Step 1: Create feature branch from main**

```bash
git checkout -b fix/production-audit main
```

**Step 2: Copy worktree changes to working directory**

```bash
# From the worktree, create a patch of all changes
cd .claude/worktrees/great-varahamihira
git diff > /tmp/worktree-changes.patch
cd /Users/jeffreyvonrotz/Projects/Finnish-law-mcp

# Apply the patch on the new branch
git apply /tmp/worktree-changes.patch

# Copy the new untracked file
cp .claude/worktrees/great-varahamihira/src/tools/list-sources.ts src/tools/list-sources.ts
```

**Step 3: Run tests to verify nothing is broken**

Run: `npm test`
Expected: All 193 tests pass (worktree changes are mostly comments/descriptions)

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: recover Finnish localization, list_sources tool, and version sync

Recovers uncommitted work from worktree claude/great-varahamihira:
- Finnish terminology across 27 files (Swedish → Finnish)
- New list_sources tool (audit Phase 1.5 compliance)
- get_provision_at_date registered in both index.ts and registry.ts
- Version bump 1.2.2 → 1.2.3 in server.json, manifest.json, api/health.ts, api/mcp.ts"
```

---

### Task 2: Fix WAL journal mode → DELETE in all build scripts

**Files:**
- Modify: `scripts/build-db.ts:639`
- Modify: `scripts/build-db-paid.ts:106`
- Modify: `scripts/ingest-lagennu-cases.ts:502`
- Modify: `scripts/ingest-lagennu-full-archive.ts:309`
- Modify: `scripts/sync-lagennu-cases.ts:247`

**Step 1: Replace all WAL pragmas with DELETE**

In each file, change:
```typescript
db.pragma('journal_mode = WAL');
```
to:
```typescript
db.pragma('journal_mode = DELETE');
```

Also in `scripts/build-db.ts:1114`, change:
```typescript
db.pragma('wal_checkpoint(TRUNCATE)');
```
to: (remove this line — no WAL checkpoint needed in DELETE mode)

**Step 2: Run tests**

Run: `npm test`
Expected: All tests pass (WAL only affects build scripts, not test fixtures)

**Step 3: Commit**

```bash
git add scripts/build-db.ts scripts/build-db-paid.ts scripts/ingest-lagennu-cases.ts scripts/ingest-lagennu-full-archive.ts scripts/sync-lagennu-cases.ts
git commit -m "fix: change SQLite journal mode from WAL to DELETE

WAL creates sidecar files (-wal, -shm) that break in Vercel serverless
where only the main .db file is deployed. DELETE mode is self-contained."
```

---

### Task 3: Add jurisdiction to db_metadata

**Files:**
- Modify: `scripts/build-db.ts:1107-1110`

**Step 1: Add jurisdiction insert**

After line 1110 (`insertMeta.run('builder', 'build-db.ts');`), add:
```typescript
    insertMeta.run('jurisdiction', 'FI');
```

**Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add scripts/build-db.ts
git commit -m "fix: add jurisdiction 'FI' to db_metadata table"
```

---

### Task 4: Rewrite test fixture with Finnish legal data

This is the largest task. The test fixture `tests/fixtures/test-db.ts` contains Swedish law data that must become Finnish. **12 test files** reference this data by ID.

**Files:**
- Modify: `tests/fixtures/test-db.ts` (complete rewrite of data arrays)
- Modify: `tests/tools/search-legislation.test.ts`
- Modify: `tests/tools/get-provision.test.ts`
- Modify: `tests/tools/search-case-law.test.ts`
- Modify: `tests/tools/get-preparatory-works.test.ts`
- Modify: `tests/tools/validate-citation.test.ts`
- Modify: `tests/tools/format-citation.test.ts`
- Modify: `tests/tools/check-currency.test.ts`
- Modify: `tests/tools/eu-cross-reference.test.ts`
- Modify: `tests/tools/build-legal-stance.test.ts`
- Modify: `tests/citation/parser.test.ts`
- Modify: `tests/citation/formatter.test.ts`
- Modify: `tests/citation/validator.test.ts`

**Step 1: Rewrite test-db.ts data arrays**

Replace `SAMPLE_DOCUMENTS` — change IDs from SFS format (`2018:218`) to Finnish format (`1050/2018`):
- `2018:218` → `1050/2018` (Tietosuojalaki / Data Protection Act)
- `1998:204` → `523/1999` (Henkilötietolaki / old Personal Data Act, repealed)
- `2017/18:105` → `HE 9/2018 vp` (Government proposal for Tietosuojalaki)
- `2017:39` → `LaVM 13/2018 vp` (Committee report)
- `NJA 2020` → `KKO:2020:45` (Supreme Court)
- `HFD 2019` → `KHO:2019:100` (Supreme Administrative Court)

Replace `SAMPLE_PROVISIONS` content with Finnish text. Keep the same structure (chapters, sections) but use Finnish language.

Replace `SAMPLE_CASE_LAW` courts: `HD` → `KKO`, `HFD` → `KHO`.

Replace `SAMPLE_PREPARATORY_WORKS` IDs and Finnish titles.

Replace `SAMPLE_DEFINITIONS` with Finnish terms.

Replace `SAMPLE_CROSS_REFS` IDs.

Replace `SAMPLE_EU_REFERENCES` source IDs.

Also update the `title_sv` column reference in `eu_documents` schema to `title_fi`.

Also update the document type CHECK constraint to include `'government_proposal'` and `'committee_report'` instead of `'sou'` and `'ds'` — but only if existing tests don't rely on `'sou'`/`'ds'` types. The safer approach is to keep `'bill'` and `'sou'` in the CHECK constraint for backward compatibility with the parser, and just change the fixture data to use `'bill'` for HE documents.

**Step 2: Update all 12 test files**

For each test file, find-and-replace:
- `'2018:218'` → `'1050/2018'`
- `'1998:204'` → `'523/1999'`
- `'2017/18:105'` → `'HE 9/2018 vp'`
- `'2017:39'` → `'LaVM 13/2018 vp'`
- `'NJA 2020'` → `'KKO:2020:45'`
- `'HFD 2019'` → `'KHO:2019:100'`
- `'HD'` → `'KKO'` (court filter)
- `'HFD'` → `'KHO'` (court filter)
- `'DSL'` → `'TietosuojaL'` (short name)
- `'PUL'` → `'HenkilötietoL'` (short name)
- Swedish provision text assertions → Finnish provision text assertions

Some tests assert specific text content (e.g., `expect(result).toContain('personuppgifter')`). These need to become Finnish equivalents (`'henkilötieto'`).

**Step 3: Run tests iteratively**

Run: `npm test`
Expected: Fix failures one test file at a time until all 193+ pass.

**Step 4: Commit**

```bash
git add tests/
git commit -m "fix: rewrite test fixtures with Finnish legal data

Replace all Swedish law sample data with Finnish equivalents:
- Tietosuojalaki (1050/2018) replaces DSL (2018:218)
- Henkilötietolaki (523/1999) replaces PUL (1998:204)
- KKO/KHO courts replace HD/HFD
- Finnish-language provision text and definitions
- All 12 test files updated with new IDs and assertions"
```

---

### Task 5: Improve tool descriptions with "when NOT to use" guidance

**Files:**
- Modify: `src/index.ts` (lines 121-511, TOOLS array)
- Modify: `src/tools/registry.ts` (lines 41-223, TOOLS array)

**Step 1: Add disambiguation to index.ts tool descriptions**

For each tool, append a `When NOT to use:` section. Key disambiguations:

`search_legislation`:
```
When NOT to use: If you already know the exact statute number and provision, use get_provision instead. If you need a comprehensive multi-source answer, use build_legal_stance.
```

`get_provision`:
```
When NOT to use: If you are searching by keyword and don't know the exact statute/provision, use search_legislation instead.
```

`search_case_law`:
```
When NOT to use: If you need statute text, use search_legislation. Case law searches only cover court decisions, not statutory provisions.
```

`get_preparatory_works`:
```
When NOT to use: If you need the statute text itself, use get_provision. Preparatory works explain legislative intent, not current law text.
```

`build_legal_stance`:
```
When NOT to use: If you need a specific provision or a targeted search, use get_provision or search_legislation. This tool is for broad legal research across multiple source types.
```

`get_eu_basis`:
```
When NOT to use: If you need EU basis for a specific provision (not the whole statute), use get_provision_eu_basis instead. If you want to find which Finnish laws implement a specific EU directive, use get_finnish_implementations.
```

`get_provision_eu_basis`:
```
When NOT to use: If you need EU basis for the entire statute (not a specific provision), use get_eu_basis instead.
```

`get_finnish_implementations`:
```
When NOT to use: If you have a Finnish statute and want to find its EU basis, use get_eu_basis instead. This tool works in the opposite direction (EU → Finnish).
```

`validate_citation`:
```
When NOT to use: If you want to format a citation string, use format_citation. This tool checks existence in the database, not formatting.
```

`format_citation`:
```
When NOT to use: If you want to check whether a citation is valid (exists in database), use validate_citation instead.
```

**Step 2: Add the same guidance to registry.ts**

Mirror the same descriptions for the registry.ts TOOLS array (used by the HTTP transport).

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass (description changes don't affect behavior)

**Step 4: Commit**

```bash
git add src/index.ts src/tools/registry.ts
git commit -m "fix: add 'when NOT to use' guidance to all tool descriptions

Improves agent discoverability per audit Phase 1.2 — each tool now
includes disambiguation guidance so LLM agents can pick the right tool."
```

---

### Task 6: Add JSON Schema min/max constraints to limit parameters

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tools/registry.ts`

**Step 1: Add numeric constraints to all limit fields**

For every `limit` property in both files, change from:
```typescript
limit: { type: 'number', description: 'Maximum results (default: 10, max: 50)' },
```
to:
```typescript
limit: { type: 'number', description: 'Maximum results (default: 10, max: 50)', default: 10, minimum: 1, maximum: 50 },
```

Specific limits per tool:
- `search_legislation`: default 10, max 50
- `search_case_law`: default 10, max 50
- `build_legal_stance`: default 5, max 20
- `search_eu_implementations`: default 20, max 100

**Step 2: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/index.ts src/tools/registry.ts
git commit -m "fix: add JSON Schema min/max constraints to limit parameters

Machine-readable bounds prevent LLM agents from requesting invalid limits."
```

---

### Task 7: Complete sources.yml with EUR-Lex entry

**Files:**
- Modify: `sources.yml`

**Step 1: Add EUR-Lex source entry**

After the Finlex source block, add:

```yaml
  - name: 'EUR-Lex'
    authority: 'Publications Office of the European Union'
    official_portal: 'https://eur-lex.europa.eu'
    canonical_identifier: 'CELEX number (e.g., 32016R0679)'
    retrieval_method: 'EUR-Lex CELLAR API'
    api_documentation: 'https://eur-lex.europa.eu/content/tools/webservices/SearchWebServiceUserManual_v2.00.pdf'
    update_frequency: 'as needed'
    last_ingested: '2026-02-14'
    license_or_terms:
      type: 'EU public domain'
      url: 'https://eur-lex.europa.eu/content/legal-notice/legal-notice.html'
      summary: 'EU law documents are public domain'
    coverage:
      scope: 'EU directives and regulations referenced by Finnish statutes'
      limitations: 'Metadata only — full EU regulation text available via EU Regulations MCP'
    languages:
      - 'en'
      - 'fi'
```

**Step 2: Commit**

```bash
git add sources.yml
git commit -m "fix: add EUR-Lex entry to sources.yml for complete provenance"
```

---

### Task 8: Compute golden hashes from current database

**Files:**
- Modify: `fixtures/golden-hashes.json`

**Step 1: Check if drift-detect script can compute hashes**

```bash
npm run drift-detect 2>&1 || echo "Script not available as npm command"
```

If no npm script exists, check for:
```bash
ls scripts/drift-detect*
```

**Step 2: Compute hashes manually if needed**

For each provision in `golden-hashes.json`, query the database and compute SHA256:

```bash
sqlite3 data/database.db "SELECT content FROM legal_provisions WHERE document_id='731/1999' AND provision_ref='1'" | shasum -a 256
```

Do this for all 5 entries and update the `expected_sha256` fields.

**Step 3: Commit**

```bash
git add fixtures/golden-hashes.json
git commit -m "fix: compute real SHA256 drift-detection hashes from current database"
```

---

### Task 9: Final verification

**Step 1: Run full test suite**

```bash
npm test
```

Expected: All 193+ tests pass

**Step 2: Build TypeScript**

```bash
npm run build
```

Expected: Clean build, no errors

**Step 3: Verify tool count**

```bash
node -e "
const { TOOLS } = require('./dist/tools/registry.js');
console.log('Tool count:', TOOLS.length);
TOOLS.forEach(t => console.log(' -', t.name));
"
```

Expected: 15+ tools including `list_sources` and `get_provision_at_date`

---

### Task 10: Update Finnish localization in CLAUDE.md (if not already done by worktree)

**Files:**
- Modify: `CLAUDE.md`

The worktree already contains these changes. Verify they were applied in Task 1. If not, apply the Finnish localization changes from the worktree diff.

Key changes: Swedish → Finnish throughout (data sources, law structure, citation formats, example queries, etc.).

**Step 1: Verify CLAUDE.md is Finnish-localized**

Check for any remaining "Swedish" or "Riksdagen" references.

**Step 2: Commit if needed**

```bash
git add CLAUDE.md
git commit -m "docs: complete Finnish localization of CLAUDE.md"
```
