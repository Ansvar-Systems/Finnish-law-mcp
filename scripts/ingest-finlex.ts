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
  parseLifecycle,
  deriveSeedStatus,
  assertCurrentConsolidation,
  buildIngestStamp,
  decideRewrite,
  stampedVersionOf,
  type ContentAbsentStamp,
  type FetchDecision,
  type FinlexDocType,
  type IngestStamp,
  type StatuteLifecycle,
  type VersionIdentity,
} from './lib/finlex-version.js';
import { writeFileAtomicSync } from './lib/fs-atomic.js';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SOURCE_CACHE_DIR = path.resolve(SCRIPT_DIR, '../data/source/finlex');
/**
 * Version-keyed forensic copies of fetched consolidated XML. Deliberately
 * OUTSIDE data/source/finlex: that directory's contents are git-tracked
 * corpus inputs, and forensic copies (one per statute per language per
 * version) would bury them in hundreds of MB of write-only output.
 * data/source-cache/ is gitignored.
 */
const FORENSIC_CACHE_DIR = path.resolve(SCRIPT_DIR, '../data/source-cache/finlex');
const VERSION_TOKEN_RE = /^\d{8}$/u;

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
  /** True when the body is an explicit empty shell (<hcontainer name="contentAbsent"/>). */
  contentAbsent: boolean;
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
  /**
   * Swedish consolidation version stamped on the existing seed
   * (`_ingest.languages.swe.consolidation_version`). skip_current requires
   * BOTH languages' stamped versions to match the fetched Finnish version —
   * otherwise a seed written with Swedish omitted would park forever.
   */
  existingStampedSwedishVersion?: string | null;
  /**
   * Directory for version-keyed forensic copies of consolidated XML.
   * Defaults to data/source-cache/finlex (gitignored — NEVER the tracked
   * data/source/finlex corpus-input directory). Tests should pass a tmp dir.
   */
  forensicCacheDir?: string;
}

function readSeedJson(seedPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  } catch {
    return null; // missing/torn seed: no stamp to read — self-heal semantics
  }
}

export type SwedishOutcome =
  | 'consolidated'
  | 'original'
  | 'omitted_not_available'
  | 'omitted_version_mismatch'
  /** Swedish expression fetched but parsed to zero provisions (empty shell). */
  | 'omitted_content_absent'
  /** Seed already current — the Swedish expression was never requested. */
  | 'not_fetched';

export interface IngestOutcome {
  decision: FetchDecision;
  written: boolean;
  /** True when upstream has no consolidated document (definitive 404) and the as-enacted original was used. */
  consolidationAbsent: boolean;
  /** True when the consolidation exists upstream but is an empty contentAbsent shell — as-enacted text used, stamped. */
  contentAbsentFallback: boolean;
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

/**
 * Named-hcontainer fallback for the issue #82 shape gap: 22 as-enacted
 * statutes (short amendment/transition acts and annex amendments) carry NO
 * <section> elements — their text lives in named hcontainers. This fallback
 * runs ONLY when the section walk yields zero provisions, and extracts from
 * an explicit whitelist:
 *
 *   statuteTextWrapper -> ref 'teksti'      (substantive standalone text)
 *   entryIntoForce     -> ref 'voimaantulo' (entry into force)
 *   attachment         -> ref 'liite'       (annex tables — for "liitteen
 *                         muuttamisesta" acts the annex IS the substance)
 *
 * conclusions / preliminaryWork / signatures are NEVER extracted: preparatory
 * references and signatures are not law text. The elided-amendment marker
 * <p class="omission"/> is empty and naturally drops out (empty content is
 * skipped), so an omission-only wrapper yields no fabricated provision.
 *
 * eIds are language-independent (hcontainer:<name>) so Finnish/Swedish
 * provisions pair by eId exactly like sectioned documents.
 */
const FALLBACK_EXCLUDED_HCONTAINERS = new Set([
  'conclusions',
  'preliminaryWork',
  'signatures',
  'contentAbsent',
]);

function collectHcontainersByName(node: unknown, out: Map<string, Record<string, unknown>[]>): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectHcontainersByName(item, out);
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@_')) continue;
    if (key === 'hcontainer') {
      for (const hc of asArray(value as Record<string, unknown> | Record<string, unknown>[])) {
        const name = typeof hc['@_name'] === 'string' ? (hc['@_name'] as string) : '';
        // Never descend into excluded containers: nothing inside conclusions
        // (preliminary works, signatures) may surface as law text.
        if (FALLBACK_EXCLUDED_HCONTAINERS.has(name)) continue;
        if (name) {
          const list = out.get(name) ?? [];
          list.push(hc);
          out.set(name, list);
        }
        collectHcontainersByName(hc, out);
      }
    } else {
      collectHcontainersByName(value, out);
    }
  }
}

function extractNamedHcontainerProvisions(body: unknown, out: FinlexProvision[]): void {
  const byName = new Map<string, Record<string, unknown>[]>();
  collectHcontainersByName(body, byName);

  const pushAll = (
    nodes: Record<string, unknown>[],
    section: string,
    title: string,
    eIdBase: string
  ): void => {
    nodes.forEach((node, index) => {
      const content = normalizeProvisionContent(textFromNode(node.content));
      if (!content) return; // omission-only / empty containers yield nothing
      const suffix = nodes.length > 1 ? `-${index + 1}` : '';
      out.push({
        eId: `${eIdBase}${suffix}`,
        section: `${section}${suffix}`,
        title,
        content,
      });
    });
  };

  pushAll(byName.get('statuteTextWrapper') ?? [], 'teksti', 'Säädöksen teksti', 'hcontainer:statuteTextWrapper');
  pushAll(byName.get('entryIntoForce') ?? [], 'voimaantulo', 'Voimaantulo', 'hcontainer:entryIntoForce');
  pushAll(byName.get('attachment') ?? [], 'liite', 'Liite', 'hcontainer:attachment');
}

interface FetchExpressionOptions {
  fetchImpl?: typeof fetch;
  cacheDir: string;
  forensicDir: string;
  retryBackoffMs?: number[];
}

/**
 * Fetch one AKN expression. Returns null ONLY on a definitive upstream 404;
 * transient failures (5xx/429/network) retry inside fetchWithRetry and then
 * THROW — they are never reported as "gone".
 *
 * Cache policy: original (as-enacted) expressions are immutable, so the
 * version-blind cache file may be read back — but only after it VALIDATES
 * (a truncated file from an interrupted run must self-heal via refetch, not
 * fail every later run). Consolidated expressions are NEVER read from cache —
 * a version-blind cache read is exactly the stale-version pin this module
 * exists to remove. Fetched consolidated XML goes to a version-keyed forensic
 * copy in the gitignored forensic dir; superseded versions are pruned.
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
    const cached = fs.readFileSync(originalCachePath, 'utf-8');
    try {
      parseVersionIdentity(cached);
      // Head-only identity parsing accepts body-torn files (empirically: a
      // 60%-truncated statute still parses with partial provisions). The
      // closing root tag is the cheap whole-document integrity witness.
      if (!cached.trimEnd().endsWith('</akomaNtoso>')) {
        throw new Error('cache file does not end with </akomaNtoso> — truncated body');
      }
      return cached;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `  Corrupt original-XML cache ${originalCachePath} (${message}) — removing it and refetching.`
      );
      fs.unlinkSync(originalCachePath);
    }
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
  if (docType === 'statute') {
    writeFileAtomicSync(originalCachePath, body);
  } else {
    const identity = parseVersionIdentity(body);
    const versionKey = identity.version_number ?? 'unversioned';
    const prefix = `${year}_${number}_${lang}@`;
    const currentCopy = `${prefix}${versionKey}.consolidated.xml`;
    fs.mkdirSync(opts.forensicDir, { recursive: true });
    // Write FIRST, then prune to the NEWEST version per statute+language
    // (round 3): in the stale_upstream case the just-fetched expression is
    // OLDER than an existing audit copy — the newer copy (the XML the kept
    // seed was built from) must survive, and a write failure must never
    // leave zero copies.
    writeFileAtomicSync(path.join(opts.forensicDir, currentCopy), body);
    const versionOf = (file: string): string =>
      file.slice(prefix.length, -'.consolidated.xml'.length);
    const copies = fs
      .readdirSync(opts.forensicDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.consolidated.xml'));
    const newest = copies.reduce((a, b) => {
      const va = versionOf(a);
      const vb = versionOf(b);
      if (va === 'unversioned') return b;
      if (vb === 'unversioned') return a;
      return vb > va ? b : a;
    });
    for (const file of copies) {
      if (file !== newest) {
        fs.unlinkSync(path.join(opts.forensicDir, file));
      }
    }
  }

  return body;
}

function isContentAbsentBody(xml: string): boolean {
  const body = /<body[\s>][\s\S]*?<\/body>/u.exec(xml)?.[0];
  if (!body) return false;
  if (!/<hcontainer[^>]*\bname="contentAbsent"/u.test(body)) return false;
  // Substantive vocabulary in the body disqualifies the empty-shell reading.
  return !/<(section|chapter|paragraph|subsection|article)[\s>]/u.test(body);
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

  const contentAbsent = isContentAbsentBody(xml);

  const provisions: FinlexProvision[] = [];
  extractProvisions(body, undefined, provisions);
  // Issue #82 shape gap: bodies without <section> vocabulary (short
  // amendment/transition acts, annex amendments) fall back to whitelisted
  // named hcontainers. Scoped two ways: only when the section walk found
  // nothing, and NEVER for an explicit contentAbsent shell — the shell must
  // stay zero-provision so the ingest-level as-enacted fallback fires
  // (serving only annex scraps from a shell would mask the real text).
  if (provisions.length === 0 && !contentAbsent) {
    extractNamedHcontainerProvisions(body, provisions);
  }

  return {
    id,
    title,
    issuedDate,
    documentNumber: parseDocumentNumber(preface),
    category,
    provisions,
    // Finlex publishes some consolidations as explicit empty shells:
    // <body><hcontainer name="contentAbsent"/></body>. STRUCTURAL check
    // (round 3): the marker must be inside the body AND the body must hold
    // no substantive vocabulary — a marker elsewhere in the document must
    // never reroute an extractor shape-gap into the silent fallback.
    contentAbsent,
  };
}

/**
 * Body-identity check (Dutch round-2 lesson, dutch-law 976c0ef): the served
 * document's own preface identity must match the requested statute. Redirects
 * are followed transparently, so without this check a mis-served body would
 * be written under the requested statute's filename with the WRONG content.
 */
function assertBodyIdentity(parsed: ParsedStatute, canonicalId: string, label: string): void {
  if (!parsed.documentNumber) return; // no preface docNumber upstream — nothing to compare
  const served = normalizeCanonicalStatuteId(parsed.id);
  if (served !== canonicalId) {
    throw new Error(
      `Body identity mismatch for ${label}: requested ${canonicalId} but upstream served ${served} — refusing to seed mis-served content`
    );
  }
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
    forensicDir: options.forensicCacheDir ?? FORENSIC_CACHE_DIR,
    retryBackoffMs: options.retryBackoffMs,
  };
  // The 404-confirm and stale-upstream guards key on the stamp. Callers may
  // supply it, but the default is the TARGET SEED's own stamp — otherwise the
  // guards are dead code on every path that forgets the option (the CLI
  // single-statute entry steered operators onto exactly that path, round 3).
  const stampedVersion = options.existingStampedVersion ?? stampedVersionOf(readSeedJson(targetPath));

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

  if (finXml === null && stampedVersion !== null && VERSION_TOKEN_RE.test(stampedVersion)) {
    // The stamp PROVES a consolidation existed upstream. A single unretried
    // 404 must not silently downgrade the seed to as-enacted text: confirm
    // once, and treat a persistent 404 as a loud anomaly.
    console.warn(
      `  404 on statute-consolidated for ${canonicalId}, but the seed stamp (${stampedVersion}) proves a ` +
        'consolidation existed — confirming before treating it as real.'
    );
    await politeDelay(delayMs);
    finXml = await fetchExpression('statute-consolidated', year, fetchNumberToken, 'fin', 'latest', fetchOpts);
    if (finXml === null) {
      throw new Error(
        `Consolidated expression for ${canonicalId} DISAPPEARED upstream (persistent 404, stamp ` +
          `${stampedVersion} proves it existed) — anomaly; refusing the silent downgrade to as-enacted text`
      );
    }
  }

  if (finXml === null) {
    // No stamp to prove a consolidation existed — but the consolidated-404
    // classification shapes the corpus (as-enacted cohort), so a single
    // unretried 404 is not enough evidence either way: confirm once (round 3).
    await politeDelay(delayMs);
    finXml = await fetchExpression('statute-consolidated', year, fetchNumberToken, 'fin', 'latest', fetchOpts);
  }

  if (finXml === null) {
    consolidationAbsent = true;
    console.log(
      `  No consolidated document for ${canonicalId} (404, confirmed by second probe) — acquiring as-enacted original.`
    );
    await politeDelay(delayMs);
    finXml = await fetchExpression('statute', year, fetchNumberToken, 'fin', '', fetchOpts);
  }

  if (finXml === null) {
    throw new Error(
      `Statute ${canonicalId} not found upstream: 404 for both statute-consolidated and statute expressions.`
    );
  }

  let finIdentity = parseVersionIdentity(finXml);
  if (!consolidationAbsent) {
    assertCurrentConsolidation(finIdentity);
  }

  // Refresh short-circuit and stale-upstream guard, keyed on the stamp.
  let decision = decideRewrite({
    stampedVersion,
    fetchedVersion: finIdentity.version_number,
  });
  if (decision === 'stale_upstream') {
    // fin@latest sits behind a ~10-min server-side cache; an expression older
    // than the stamp is a realistic transient. The stamp proves newer text was
    // already acquired — keep it, surface the anomaly, never rewrite backwards.
    if (!fs.existsSync(targetPath)) {
      throw new Error(
        `Stale upstream for ${canonicalId} (fetched ${finIdentity.version_number}, stamped ${stampedVersion}) ` +
          'with no local seed file — inconsistent caller state, refusing to write the older expression'
      );
    }
    console.warn(
      `  STALE UPSTREAM for ${canonicalId}: fetched consolidation ${finIdentity.version_number} is OLDER than ` +
        `the stamped ${stampedVersion} — keeping the newer seed untouched.`
    );
    return {
      decision,
      written: false,
      consolidationAbsent,
      contentAbsentFallback: false,
      identity: finIdentity,
      swedish: 'not_fetched',
    };
  }
  // skip_current requires BOTH languages to be proven current: a seed whose
  // Swedish text was omitted (no swe stamp) must be re-examined — the Swedish
  // consolidation may have caught up since.
  if (decision === 'skip_current') {
    if (
      fs.existsSync(targetPath) &&
      (options.existingStampedSwedishVersion ?? null) === finIdentity.version_number
    ) {
      console.log(
        `  Seed already at consolidation ${finIdentity.version_number} (both languages) — skipping rewrite.`
      );
      return {
        decision,
        written: false,
        consolidationAbsent,
        contentAbsentFallback: false,
        identity: finIdentity,
        swedish: 'not_fetched',
      };
    }
    if (fs.existsSync(targetPath)) {
      console.log(
        `  Finnish text already at ${finIdentity.version_number}, but the Swedish stamp does not match — ` +
          're-examining the Swedish expression.'
      );
      decision = 'refetch_check';
    } else {
      decision = 'refetch_unknown'; // stamped current but the seed file is missing — rebuild it
    }
  }

  // 2. Parse the Finnish text and apply the zero-provision gate: a document
  //    that parses to zero provisions must never become a seed. The ONLY
  //    recognized empty shape is Finlex's explicit contentAbsent shell, which
  //    triggers a stamped fallback to the as-enacted original; anything else
  //    fails loud (unknown vocabulary/shape).
  let fiParsed = parseFinlexXml(finXml, canonicalId);
  // Lifecycle facts for the status: from the document that CARRIES them — the
  // consolidated expression (or shell). As-enacted originals publish none.
  let lifecycle: StatuteLifecycle = parseLifecycle(finXml);
  let lifecycleDocType: FinlexDocType = finIdentity.doc_type;
  let contentAbsentStamp: ContentAbsentStamp | undefined;

  if (fiParsed.provisions.length === 0) {
    if (!consolidationAbsent && fiParsed.contentAbsent) {
      console.warn(
        `  Consolidation ${finIdentity.version_number ?? 'unversioned'} for ${canonicalId} is an EMPTY ` +
          'contentAbsent shell — explicit fallback to the as-enacted original (stamped as such).'
      );
      contentAbsentStamp = {
        version: finIdentity.version_number,
        consolidated_to: finIdentity.consolidated_to,
      };
      await politeDelay(delayMs);
      const originalXml = await fetchExpression('statute', year, fetchNumberToken, 'fin', '', fetchOpts);
      if (originalXml === null) {
        throw new Error(
          `Statute ${canonicalId}: consolidated expression is a contentAbsent shell AND the as-enacted ` +
            'original is gone (404) — nothing real to seed, failing loud'
        );
      }
      finXml = originalXml;
      finIdentity = parseVersionIdentity(finXml);
      fiParsed = parseFinlexXml(finXml, canonicalId);
      if (fiParsed.provisions.length === 0) {
        throw new Error(
          `Statute ${canonicalId}: zero provisions in BOTH the consolidated shell and the as-enacted ` +
            'original — refusing to write a hollow seed'
        );
      }
    } else {
      throw new Error(
        `Statute ${canonicalId}: document ${finIdentity.expression_uri} parsed to ZERO provisions without a ` +
          'recognized contentAbsent marker — unknown document shape, refusing to write a hollow seed'
      );
    }
  }

  assertBodyIdentity(fiParsed, canonicalId, `Finnish expression ${finIdentity.expression_uri}`);

  // 3. Acquire Swedish text at the SAME version discipline. A Swedish
  //    consolidation at a different version is omitted (loudly) rather than
  //    silently paired with Finnish text from another point in time. When the
  //    Finnish text is the as-enacted original (consolidated 404 or
  //    contentAbsent shell), Swedish pairs with the as-enacted original too.
  let sweXml: string | null = null;
  let sweIdentity: VersionIdentity | null = null;
  let swedish: SwedishOutcome = 'omitted_not_available';

  await politeDelay(delayMs);
  if (consolidationAbsent || contentAbsentStamp) {
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

  let svParsed = sweXml ? parseFinlexXml(sweXml, canonicalId) : null;
  if (svParsed) {
    assertBodyIdentity(svParsed, canonicalId, `Swedish expression ${sweIdentity?.expression_uri ?? 'unknown'}`);
  }
  // Zero-provision Swedish text must never be stamped as present (round 3):
  // version equality alone proved nothing about CONTENT — an empty shell
  // stamped 'consolidated' parks the seed as bilingual-complete forever.
  if (svParsed && svParsed.provisions.length === 0) {
    console.warn(
      `  Warning: Swedish expression for ${canonicalId} parsed to ZERO provisions` +
        `${svParsed.contentAbsent ? ' (contentAbsent shell)' : ''} — omitting Swedish text.`
    );
    svParsed = null;
    sweXml = null;
    sweIdentity = null;
    swedish = 'omitted_content_absent';
  }

  const svByEid = new Map<string, FinlexProvision>(
    (svParsed?.provisions ?? []).map(p => [p.eId, p])
  );

  // Pairing-symmetry check (PR #83 review, P2): pairing is keyed by eId, and
  // the fallback's multi-instance suffix scheme means a Finnish/Swedish
  // instance-count mismatch produces eIds that never match — the Swedish
  // text would drop SILENTLY. No such document exists today; if one ever
  // appears, this must be loud, not silent.
  if (svParsed) {
    const fiEids = new Set(fiParsed.provisions.map(p => p.eId));
    const unmatchedSv = svParsed.provisions.filter(p => !fiEids.has(p.eId));
    if (unmatchedSv.length > 0) {
      console.warn(
        `  Warning: ${unmatchedSv.length} Swedish provision(s) for ${canonicalId} have no Finnish eId ` +
          `counterpart and their text will not be paired: ${unmatchedSv.map(p => p.eId).join(', ')}`
      );
    }
  }

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

  // Status is a FACT from upstream lifecycle metadata (finlex:isInForce,
  // dateInForceEnd, repealedBy), never a constant. For a contentAbsent shell
  // the SHELL carries the authoritative lifecycle even though the text comes
  // from the as-enacted original. As-enacted originals without lifecycle
  // metadata get the documented default, stamped as unverified.
  const { status, basis: statusBasis } = deriveSeedStatus({
    docType: lifecycleDocType,
    lifecycle,
  });

  // Validity claim for the served text: a consolidation proves its wording as
  // of dateConsolidated — claiming validity from the original enactment date
  // would assert amended/inserted provisions existed before they did. The
  // as-enacted original proves its wording from enactment.
  const textValidFrom = finIdentity.consolidated_to ?? fiParsed.issuedDate;

  const seed: DocumentSeed = {
    id: normalizedParsedId || canonicalId,
    type: 'statute',
    title: fiParsed.title,
    title_en: svParsed?.title,
    short_name: SHORT_NAME_BY_ID[normalizedParsedId] ?? SHORT_NAME_BY_ID[canonicalId],
    status,
    issued_date: fiParsed.issuedDate,
    in_force_date: lifecycle.date_entry_into_force ?? fiParsed.issuedDate,
    // Version-pinned expression URL — never the ambiguous-version form.
    url: `https://opendata.finlex.fi/finlex/avoindata/v1${finIdentity.expression_uri}`,
    // The repeal date must reach the downstream pipeline: build-db derives
    // document validity via extractRepealDateFromDescription, which matches
    // the 'Kumottu YYYY-MM-DD' convention (round 3 — _ingest.lifecycle alone
    // is invisible to it, so repealed acts computed as in_force downstream).
    description:
      status === 'repealed' && lifecycle.date_in_force_end
        ? `Ingested from Finlex open data (${fiParsed.category ?? 'statute'}). Kumottu ${lifecycle.date_in_force_end}`
        : `Ingested from Finlex open data (${fiParsed.category ?? 'statute'})`,
    provisions,
    provision_versions: provisions.map(p => ({
      ...p,
      valid_from: textValidFrom,
      valid_to: null,
    })),
    definitions: definitions.length > 0 ? definitions : undefined,
    preparatory_works: preparatoryWorks.length > 0 ? preparatoryWorks : undefined,
    _ingest: buildIngestStamp({
      now: new Date().toISOString(),
      primary: finIdentity,
      languages,
      lifecycle,
      statusBasis,
      consolidatedContentAbsent: contentAbsentStamp,
    }),
  };

  // Churn guard: when a refresh re-derives a byte-identical seed (everything
  // but the retrieval timestamp), keep the existing file untouched.
  const written = writeSeedUnlessUnchanged(targetPath, seed);

  console.log(`  Source expression:      ${finIdentity.expression_uri}`);
  console.log(`  Consolidation version:  ${finIdentity.version_number ?? 'none (as-enacted original)'}`);
  console.log(`  Status:                 ${status} (${statusBasis})`);
  console.log(`  Swedish text:           ${swedish}`);
  console.log(`  Parsed provisions (FI): ${fiParsed.provisions.length}`);
  console.log(`  Parsed provisions (SV): ${svParsed?.provisions.length ?? 0}`);
  console.log(`  Definitions extracted:  ${definitions.length}`);
  console.log(`  Preparatory refs:       ${preparatoryWorks.length}`);
  console.log(written ? `\n✅ Wrote seed file: ${targetPath}` : `\n✅ Seed unchanged: ${targetPath}`);

  return {
    decision,
    written,
    consolidationAbsent,
    contentAbsentFallback: contentAbsentStamp !== undefined,
    identity: finIdentity,
    swedish,
  };
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
      // Last-line tripwire (defense in depth behind the zero-provision gate):
      // a seed holding real provisions must NEVER be replaced by an empty one.
      const existingProvisions = (existing as { provisions?: unknown[] }).provisions;
      if (
        Array.isArray(existingProvisions) &&
        existingProvisions.length > 0 &&
        (seed.provisions?.length ?? 0) === 0
      ) {
        throw new Error(
          `Refusing to overwrite ${targetPath}: existing seed has ${existingProvisions.length} provisions, ` +
            'replacement has zero — hollow overwrite blocked'
        );
      }
    } catch (error) {
      if (error instanceof Error && /hollow overwrite blocked/u.test(error.message)) {
        throw error;
      }
      // Unreadable/corrupt existing seed: overwrite it.
    }
  }
  writeFileAtomicSync(targetPath, JSON.stringify(seed, null, 2));
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
