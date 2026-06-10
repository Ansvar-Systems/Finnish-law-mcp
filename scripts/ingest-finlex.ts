#!/usr/bin/env tsx
/**
 * Finlex Data Ingestion Script
 *
 * Fetches Finnish statutes from Finlex open data (Akoma Ntoso XML) and converts
 * them to seed JSON format for reproducible `build:db` runs.
 *
 * Version discipline (issue #78): the acquisition fetches the CURRENT
 * consolidation (act/statute-consolidated/{y}/{n}/{lang}@latest, ELI ajantasa)
 * and stamps the seed with the version identity (`_ingest`). The original
 * as-enacted expression (act/statute/{y}/{n}/{lang}@, ELI alkup) is used only
 * when upstream answers a definitive 404 for the consolidated document — and
 * that, too, is stamped. See scripts/lib/finlex-version.ts for the semantics.
 *
 * Usage:
 *   npm run ingest -- <statute-id> [output-path]
 *
 * Examples:
 *   npm run ingest -- 1050/2018
 *   npm run ingest -- 738/2002 data/seed/738_2002.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { XMLParser } from 'fast-xml-parser';
import { foldNordicText, normalizeLegalText } from '../src/utils/legal-normalization.js';
import {
  fetchWithRetry,
  politeDelay,
  FINLEX_REQUEST_DELAY_MS,
  FINLEX_USER_AGENT,
} from './lib/finlex-http.js';
import {
  FINLEX_API_BASE,
  parseVersionIdentity,
  assertCurrentConsolidation,
  buildIngestStamp,
  decideRewrite,
  type FetchDecision,
  type FinlexDocType,
  type IngestStamp,
  type VersionIdentity,
} from './lib/finlex-version.js';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SOURCE_CACHE_DIR = path.resolve(SCRIPT_DIR, '../data/source/finlex');

interface DocumentSeed {
  id: string;
  type: 'statute' | 'bill' | 'sou' | 'ds' | 'case_law';
  title: string;
  title_en?: string;
  short_name?: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date?: string;
  in_force_date?: string;
  url?: string;
  description?: string;
  provisions?: ProvisionSeed[];
  provision_versions?: ProvisionVersionSeed[];
  definitions?: DefinitionSeed[];
  preparatory_works?: PrepWorkSeed[];
  /** Version identity of the upstream expression this seed was built from (issue #78). */
  _ingest?: IngestStamp;
}

interface ProvisionSeed {
  provision_ref: string;
  chapter?: string;
  section: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface ProvisionVersionSeed extends ProvisionSeed {
  valid_from?: string;
  valid_to?: string;
}

interface DefinitionSeed {
  term: string;
  definition: string;
  source_provision?: string;
}

interface PrepWorkSeed {
  prep_document_id: string;
  title: string;
  summary?: string;
}

interface FinlexProvision {
  eId: string;
  chapter?: string;
  section: string;
  title?: string;
  content: string;
  /** Amending statute label from finlex:originalVersionLabel, e.g. '27.11.2020/902'. */
  amendedBy?: string;
}

interface ParsedStatute {
  id: string;
  title: string;
  issuedDate?: string;
  documentNumber?: string;
  category?: string;
  provisions: FinlexProvision[];
}

export interface IngestFinlexOptions {
  /**
   * Optional explicit Finlex number token for API fetches.
   * Needed for historical statutes that use version suffixes, e.g. "39-001".
   */
  fetchNumberToken?: string;
  /**
   * Optional override for canonical statute id written to seed file.
   */
  canonicalStatuteId?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Politeness delay between Finlex requests. Defaults to FINLEX_REQUEST_DELAY_MS (2s). */
  delayMs?: number;
  /** Source XML cache directory. Defaults to data/source/finlex. */
  cacheDir?: string;
  /** Retry backoff override (tests). */
  retryBackoffMs?: number[];
  /**
   * Consolidation version stamped on the existing seed (`_ingest.consolidation_version`),
   * passed by refresh callers. When the fetched version equals it, the seed is
   * NOT rewritten (decision 'skip_current').
   */
  existingStampedVersion?: string | null;
}

export type SwedishOutcome =
  | 'consolidated'
  | 'original'
  | 'omitted_not_available'
  | 'omitted_version_mismatch'
  /** Seed already current — the Swedish expression was never requested. */
  | 'not_fetched';

export interface IngestOutcome {
  decision: FetchDecision;
  written: boolean;
  /** True when upstream has no consolidated document (definitive 404) and the as-enacted original was used. */
  consolidationAbsent: boolean;
  identity: VersionIdentity;
  swedish: SwedishOutcome;
}

const SHORT_NAME_BY_ID: Record<string, string> = {
  '1050/2018': 'Tietosuojalaki',
  '738/2002': 'Tyoturvallisuuslaki',
  '434/2003': 'Hallintolaki',
  '39/1889': 'Rikoslaki',
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromNode(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(item => textFromNode(item)).join(' ');
  }
  if (typeof node === 'object') {
    const values = Object.entries(node as Record<string, unknown>)
      .filter(([key]) => !key.startsWith('@_'))
      .map(([, value]) => textFromNode(value));
    return values.join(' ');
  }
  return '';
}

function parseChapterNumber(raw: string): string | undefined {
  const match = normalizeLegalText(raw).match(/(\d+)/u);
  return match?.[1];
}

function parseSectionNumber(raw: string): string | undefined {
  const match = normalizeLegalText(raw).match(/(\d+\s*[a-z]?)/iu);
  return match?.[1]?.replace(/\s+/gu, ' ').trim();
}

function normalizeCanonicalNumberToken(token: string): string {
  const trimmed = token.trim();
  const withVersion = trimmed.match(/^(\d+)-\d+$/u);
  const base = withVersion ? withVersion[1] : trimmed;
  const normalized = base.replace(/^0+(?=\d)/u, '');
  return normalized.length > 0 ? normalized : '0';
}

function normalizeCanonicalStatuteId(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.match(/^([^/]+)\/(\d{4})$/u);
  if (slash) {
    return `${normalizeCanonicalNumberToken(slash[1])}/${slash[2]}`;
  }

  const colon = trimmed.match(/^(\d{4}):(.+)$/u);
  if (colon) {
    return `${normalizeCanonicalNumberToken(colon[2])}/${colon[1]}`;
  }

  return trimmed;
}

function normalizeProvisionContent(content: string): string {
  return normalizeLegalText(content)
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim();
}

function parseIssuedDate(meta: Record<string, unknown>): string | undefined {
  const identification = meta.identification as Record<string, unknown> | undefined;
  const frbrWork = identification?.FRBRWork as Record<string, unknown> | undefined;
  const dates = asArray(frbrWork?.FRBRdate as Record<string, unknown> | Record<string, unknown>[]);

  for (const dateEntry of dates) {
    if (dateEntry['@_name'] === 'dateIssued') {
      return typeof dateEntry['@_date'] === 'string' ? dateEntry['@_date'] : undefined;
    }
  }

  return undefined;
}

function parseCategory(meta: Record<string, unknown>): string | undefined {
  const proprietary = meta.proprietary as Record<string, unknown> | undefined;
  const category = proprietary?.['finlex:categoryStatute'] as Record<string, unknown> | undefined;
  const refersTo = category?.['@_refersTo'];
  if (typeof refersTo !== 'string') return undefined;
  return refersTo.replace(/^#/, '');
}

function parseDocumentNumber(preface: Record<string, unknown> | undefined): string | undefined {
  const paragraph = preface?.p as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const first = asArray(paragraph)[0];
  const value = first?.docNumber;
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseDocumentTitle(preface: Record<string, unknown> | undefined): string | undefined {
  const paragraph = preface?.p as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const first = asArray(paragraph)[0];
  const value = first?.docTitle;
  return typeof value === 'string' ? normalizeLegalText(value) : undefined;
}

function extractDefinitionsFromProvisions(provisions: ProvisionSeed[]): DefinitionSeed[] {
  const definitions: DefinitionSeed[] = [];
  const seenTerms = new Set<string>();

  for (const provision of provisions) {
    const content = provision.content;

    // Finnish definitions: "... tarkoittaa ..."
    for (const match of content.matchAll(/([A-Za-zÅÄÖåäö\- ]{3,})\s+tarkoittaa\s+([^.;]{20,})/giu)) {
      const term = normalizeLegalText(match[1]).toLowerCase();
      if (term.length < 3 || seenTerms.has(term)) continue;
      seenTerms.add(term);
      definitions.push({
        term,
        definition: normalizeLegalText(match[2]),
        source_provision: provision.provision_ref,
      });
    }

    // Swedish definitions: "... avses ..."
    for (const match of content.matchAll(/med\s+([A-Za-zÅÄÖåäö\- ]{3,})\s+avses\s+([^.;]{20,})/giu)) {
      const term = normalizeLegalText(match[1]).toLowerCase();
      if (term.length < 3 || seenTerms.has(term)) continue;
      seenTerms.add(term);
      definitions.push({
        term,
        definition: normalizeLegalText(match[2]),
        source_provision: provision.provision_ref,
      });
    }
  }

  return definitions.slice(0, 50);
}

function extractPreparatoryWorksFromContent(provisions: ProvisionSeed[]): PrepWorkSeed[] {
  const prepWorks = new Map<string, PrepWorkSeed>();

  for (const provision of provisions) {
    for (const match of provision.content.matchAll(/\bHE\s+(\d+)\/(\d{4})\s+vp\b/gu)) {
      const id = `${match[1]}/${match[2]}`;
      prepWorks.set(id, {
        prep_document_id: id,
        title: `HE ${match[1]}/${match[2]} vp`,
      });
    }
  }

  return [...prepWorks.values()];
}

function extractProvisions(node: unknown, inheritedChapter: string | undefined, out: FinlexProvision[]): void {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      extractProvisions(item, inheritedChapter, out);
    }
    return;
  }

  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  for (const chapterNode of asArray(obj.chapter as Record<string, unknown> | Record<string, unknown>[])) {
    const chapter = parseChapterNumber(textFromNode(chapterNode.num)) ?? inheritedChapter;
    extractProvisions(chapterNode, chapter, out);
  }

  for (const sectionNode of asArray(obj.section as Record<string, unknown> | Record<string, unknown>[])) {
    const section = parseSectionNumber(textFromNode(sectionNode.num));
    if (!section) continue;

    const eId = typeof sectionNode['@_eId'] === 'string'
      ? sectionNode['@_eId'] as string
      : `${inheritedChapter ?? 'flat'}:${section}`;

    const title = textFromNode(sectionNode.heading).trim() || undefined;

    const contentParts: string[] = [];
    for (const subsection of asArray(sectionNode.subsection as unknown[] | unknown)) {
      const subsectionContent = textFromNode(
        (subsection as Record<string, unknown>).content ?? subsection
      );
      if (subsectionContent.trim()) {
        contentParts.push(subsectionContent);
      }
    }
    if (contentParts.length === 0) {
      const fallback = textFromNode(sectionNode.content ?? sectionNode);
      if (fallback.trim()) contentParts.push(fallback);
    }

    const content = normalizeProvisionContent(contentParts.join('\n'));
    if (!content) continue;

    const amendedBy = typeof sectionNode['@_finlex:originalVersionLabel'] === 'string'
      ? (sectionNode['@_finlex:originalVersionLabel'] as string)
      : undefined;

    out.push({
      eId,
      chapter: inheritedChapter,
      section,
      title,
      content,
      amendedBy,
    });
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@_') || key === 'chapter' || key === 'section') continue;
    extractProvisions(value, inheritedChapter, out);
  }
}

interface FetchExpressionOptions {
  fetchImpl?: typeof fetch;
  cacheDir: string;
  retryBackoffMs?: number[];
}

/**
 * Fetch one AKN expression. Returns null ONLY on a definitive upstream 404;
 * transient failures (5xx/429/network) retry inside fetchWithRetry and then
 * THROW — they are never reported as "gone".
 *
 * Cache policy: original (as-enacted) expressions are immutable, so the
 * version-blind cache file may be read back. Consolidated expressions are
 * NEVER read from cache — a version-blind cache read is exactly the
 * stale-version pin this module exists to remove. Fetched consolidated XML is
 * written to a version-keyed file as a forensic copy only.
 */
async function fetchExpression(
  docType: FinlexDocType,
  year: string,
  number: string,
  lang: 'fin' | 'swe',
  version: 'latest' | '',
  opts: FetchExpressionOptions
): Promise<string | null> {
  const originalCachePath = path.join(opts.cacheDir, `${year}_${number}_${lang}.xml`);
  if (docType === 'statute' && fs.existsSync(originalCachePath)) {
    return fs.readFileSync(originalCachePath, 'utf-8');
  }

  const url = `${FINLEX_API_BASE}/${docType}/${year}/${number}/${lang}@${version}`;
  const res = await fetchWithRetry(url, {
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.retryBackoffMs,
    headers: {
      'User-Agent': FINLEX_USER_AGENT,
      Accept: 'application/xml,text/xml',
    },
  });

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    // fetchWithRetry only returns non-retryable 4xx here; anything but 404 is
    // a contract violation worth failing loud on.
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const body = await res.text();
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  if (docType === 'statute') {
    fs.writeFileSync(originalCachePath, body, 'utf-8');
  } else {
    const identity = parseVersionIdentity(body);
    const versionKey = identity.version_number ?? 'unversioned';
    fs.writeFileSync(
      path.join(opts.cacheDir, `${year}_${number}_${lang}@${versionKey}.consolidated.xml`),
      body,
      'utf-8'
    );
  }

  return body;
}

export function parseFinlexXml(xml: string, fallbackId: string): ParsedStatute {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
  });

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const act = (parsed.akomaNtoso as Record<string, unknown>).act as Record<string, unknown>;
  const meta = act.meta as Record<string, unknown>;
  const preface = act.preface as Record<string, unknown> | undefined;
  const body = act.body as Record<string, unknown> | undefined;

  const id = parseDocumentNumber(preface) ?? fallbackId;
  const title = parseDocumentTitle(preface) ?? `Statute ${id}`;
  const issuedDate = parseIssuedDate(meta);
  const category = parseCategory(meta);

  const provisions: FinlexProvision[] = [];
  extractProvisions(body, undefined, provisions);

  return {
    id,
    title,
    issuedDate,
    documentNumber: parseDocumentNumber(preface),
    category,
    provisions,
  };
}

function parseStatuteId(id: string): { number: string; year: string } {
  const trimmed = id.trim();
  const slash = trimmed.match(/^(\d+(?:-\d+)?)\/(\d{4})$/u);
  if (slash) {
    return { number: slash[1], year: slash[2] };
  }

  const colon = trimmed.match(/^(\d{4}):(\d+(?:-\d+)?)$/u);
  if (colon) {
    return { number: colon[2], year: colon[1] };
  }

  throw new Error(`Invalid statute ID "${id}". Expected "NNN/YYYY", "NNN-VVV/YYYY", or "YYYY:NNN".`);
}

function buildOutputPath(statuteId: string): string {
  const safe = statuteId.replace('/', '_').replace(':', '_');
  return path.resolve(SCRIPT_DIR, `../data/seed/${safe}.json`);
}

export async function ingestFinlexStatute(
  statuteId: string,
  outputPath?: string,
  options: IngestFinlexOptions = {}
): Promise<IngestOutcome> {
  const { number, year } = parseStatuteId(statuteId);
  const canonicalNumber = normalizeCanonicalNumberToken(number);
  const canonicalId = options.canonicalStatuteId
    ? normalizeCanonicalStatuteId(options.canonicalStatuteId)
    : `${canonicalNumber}/${year}`;
  const fetchNumberToken = options.fetchNumberToken?.trim() || number;
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(SCRIPT_DIR, `../data/seed/${canonicalNumber}_${year}.json`);
  const delayMs = options.delayMs ?? FINLEX_REQUEST_DELAY_MS;
  const fetchOpts: FetchExpressionOptions = {
    fetchImpl: options.fetchImpl,
    cacheDir: options.cacheDir ?? SOURCE_CACHE_DIR,
    retryBackoffMs: options.retryBackoffMs,
  };

  console.log('Finlex Data Ingestion');
  console.log(`  Statute: ${canonicalId}`);
  if (fetchNumberToken !== canonicalNumber) {
    console.log(`  Fetch key: ${fetchNumberToken}/${year}`);
  }
  console.log(`  Output:  ${targetPath}`);
  console.log('');

  // 1. Acquire Finnish text: newest consolidation first; the as-enacted
  //    original ONLY on a definitive consolidated 404 (no consolidation
  //    published — e.g. brand-new statutes). Both outcomes are stamped.
  let consolidationAbsent = false;
  let finXml = await fetchExpression('statute-consolidated', year, fetchNumberToken, 'fin', 'latest', fetchOpts);

  if (finXml === null) {
    consolidationAbsent = true;
    console.log(`  No consolidated document for ${canonicalId} (404) — acquiring as-enacted original.`);
    await politeDelay(delayMs);
    finXml = await fetchExpression('statute', year, fetchNumberToken, 'fin', '', fetchOpts);
  }

  if (finXml === null) {
    throw new Error(
      `Statute ${canonicalId} not found upstream: 404 for both statute-consolidated and statute expressions.`
    );
  }

  const finIdentity = parseVersionIdentity(finXml);
  if (!consolidationAbsent) {
    assertCurrentConsolidation(finIdentity);
  }

  // Refresh short-circuit: when the stamped version PROVES the seed already
  // holds this consolidation, keep the file untouched (no git churn).
  const decision = decideRewrite({
    stampedVersion: options.existingStampedVersion ?? null,
    fetchedVersion: finIdentity.version_number,
  });
  if (decision === 'skip_current' && fs.existsSync(targetPath)) {
    console.log(`  Seed already at consolidation ${finIdentity.version_number} — skipping rewrite.`);
    return {
      decision,
      written: false,
      consolidationAbsent,
      identity: finIdentity,
      swedish: 'not_fetched',
    };
  }

  // 2. Acquire Swedish text at the SAME version discipline. A Swedish
  //    consolidation at a different version is omitted (loudly) rather than
  //    silently paired with Finnish text from another point in time.
  let sweXml: string | null = null;
  let sweIdentity: VersionIdentity | null = null;
  let swedish: SwedishOutcome = 'omitted_not_available';

  await politeDelay(delayMs);
  if (consolidationAbsent) {
    sweXml = await fetchExpression('statute', year, fetchNumberToken, 'swe', '', fetchOpts);
    if (sweXml !== null) {
      sweIdentity = parseVersionIdentity(sweXml);
      swedish = 'original';
    }
  } else {
    sweXml = await fetchExpression('statute-consolidated', year, fetchNumberToken, 'swe', 'latest', fetchOpts);
    if (sweXml !== null) {
      sweIdentity = parseVersionIdentity(sweXml);
      if (sweIdentity.version_number !== finIdentity.version_number) {
        console.warn(
          `  Warning: Swedish consolidation ${sweIdentity.version_number ?? 'unversioned'} != ` +
            `Finnish ${finIdentity.version_number ?? 'unversioned'} for ${canonicalId} — omitting Swedish text.`
        );
        sweXml = null;
        sweIdentity = null;
        swedish = 'omitted_version_mismatch';
      } else {
        swedish = 'consolidated';
      }
    }
  }

  const fiParsed = parseFinlexXml(finXml, canonicalId);
  const svParsed = sweXml ? parseFinlexXml(sweXml, canonicalId) : null;

  const svByEid = new Map<string, FinlexProvision>(
    (svParsed?.provisions ?? []).map(p => [p.eId, p])
  );

  const provisions: ProvisionSeed[] = fiParsed.provisions.map(provision => {
    const provisionRef = provision.chapter
      ? `${provision.chapter}:${provision.section}`
      : provision.section;

    const sv = svByEid.get(provision.eId);
    const metadata: Record<string, unknown> = {
      source: 'finlex',
      source_eid: provision.eId,
      normalized_fi: normalizeLegalText(provision.content),
      folded_fi: foldNordicText(provision.content),
    };

    if (provision.amendedBy) {
      metadata.amended_by = provision.amendedBy;
    }

    if (sv) {
      metadata.title_sv = sv.title;
      metadata.content_sv = sv.content;
      metadata.normalized_sv = normalizeLegalText(sv.content);
      metadata.folded_sv = foldNordicText(sv.content);
    }

    return {
      provision_ref: provisionRef,
      chapter: provision.chapter,
      section: provision.section,
      title: provision.title,
      content: provision.content,
      metadata,
    };
  });

  const definitions = extractDefinitionsFromProvisions(provisions);
  const preparatoryWorks = extractPreparatoryWorksFromContent(provisions);
  const normalizedParsedId = normalizeCanonicalStatuteId(fiParsed.id);

  const languages: Record<string, VersionIdentity> = { fin: finIdentity };
  if (sweIdentity) {
    languages.swe = sweIdentity;
  }

  const seed: DocumentSeed = {
    id: normalizedParsedId || canonicalId,
    type: 'statute',
    title: fiParsed.title,
    title_en: svParsed?.title,
    short_name: SHORT_NAME_BY_ID[normalizedParsedId] ?? SHORT_NAME_BY_ID[canonicalId],
    status: 'in_force',
    issued_date: fiParsed.issuedDate,
    in_force_date: fiParsed.issuedDate,
    // Version-pinned expression URL — never the ambiguous-version form.
    url: `https://opendata.finlex.fi/finlex/avoindata/v1${finIdentity.expression_uri}`,
    description: `Ingested from Finlex open data (${fiParsed.category ?? 'statute'})`,
    provisions,
    provision_versions: provisions.map(p => ({
      ...p,
      valid_from: fiParsed.issuedDate,
      valid_to: null,
    })),
    definitions: definitions.length > 0 ? definitions : undefined,
    preparatory_works: preparatoryWorks.length > 0 ? preparatoryWorks : undefined,
    _ingest: buildIngestStamp({
      now: new Date().toISOString(),
      primary: finIdentity,
      languages,
    }),
  };

  // Churn guard: when a refresh re-derives a byte-identical seed (everything
  // but the retrieval timestamp), keep the existing file untouched.
  const written = writeSeedUnlessUnchanged(targetPath, seed);

  console.log(`  Source expression:      ${finIdentity.expression_uri}`);
  console.log(`  Consolidation version:  ${finIdentity.version_number ?? 'none (as-enacted original)'}`);
  console.log(`  Swedish text:           ${swedish}`);
  console.log(`  Parsed provisions (FI): ${fiParsed.provisions.length}`);
  console.log(`  Parsed provisions (SV): ${svParsed?.provisions.length ?? 0}`);
  console.log(`  Definitions extracted:  ${definitions.length}`);
  console.log(`  Preparatory refs:       ${preparatoryWorks.length}`);
  console.log(written ? `\n✅ Wrote seed file: ${targetPath}` : `\n✅ Seed unchanged: ${targetPath}`);

  return { decision, written, consolidationAbsent, identity: finIdentity, swedish };
}

/** Serialize without the volatile retrieval timestamp, for change detection. */
function canonicalSeedJson(seed: unknown): string {
  const clone = JSON.parse(JSON.stringify(seed)) as Record<string, unknown>;
  const ingest = clone._ingest as Record<string, unknown> | undefined;
  if (ingest) {
    delete ingest.retrieved_at;
  }
  return JSON.stringify(clone);
}

function writeSeedUnlessUnchanged(targetPath: string, seed: DocumentSeed): boolean {
  if (fs.existsSync(targetPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as unknown;
      if (canonicalSeedJson(existing) === canonicalSeedJson(seed)) {
        return false;
      }
    } catch {
      // Unreadable/corrupt existing seed: overwrite it.
    }
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(seed, null, 2), 'utf-8');
  return true;
}

async function main(): Promise<void> {
  const [statuteId, output] = process.argv.slice(2);
  if (!statuteId) {
    console.error('Usage: npm run ingest -- <statute-id> [output-path]');
    console.error('Example: npm run ingest -- 1050/2018 data/seed/1050_2018.json');
    process.exit(1);
  }

  await ingestFinlexStatute(statuteId, output);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Ingestion failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
