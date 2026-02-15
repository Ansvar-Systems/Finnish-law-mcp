#!/usr/bin/env tsx
/**
 * Finlex Data Ingestion Script
 *
 * Fetches Finnish statutes from Finlex open data (Akoma Ntoso XML) and converts
 * them to seed JSON format for reproducible `build:db` runs.
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
import { execFileSync } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { foldNordicText, normalizeLegalText } from '../src/utils/legal-normalization.js';

const FINLEX_BASE = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute';
const USER_AGENT = 'Finnish-Law-MCP/1.2.2 (https://github.com/Ansvar-Systems/finnish-law-mcp)';
const REQUEST_DELAY_MS = 250;
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
}

const SHORT_NAME_BY_ID: Record<string, string> = {
  '1050/2018': 'Tietosuojalaki',
  '738/2002': 'Tyoturvallisuuslaki',
  '434/2003': 'Hallintolaki',
  '39/1889': 'Rikoslaki',
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

    out.push({
      eId,
      chapter: inheritedChapter,
      section,
      title,
      content,
    });
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@_') || key === 'chapter' || key === 'section') continue;
    extractProvisions(value, inheritedChapter, out);
  }
}

async function fetchXml(year: string, number: string, lang: 'fin' | 'swe'): Promise<string | null> {
  const cachePath = path.join(SOURCE_CACHE_DIR, `${year}_${number}_${lang}.xml`);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8');
  }

  const url = `${FINLEX_BASE}/${year}/${number}/${lang}@`;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = execFileSync(
        'curl',
        [
          '-sS',
          '-L',
          '-A',
          USER_AGENT,
          '-H',
          'Accept: application/xml,text/xml',
          '-w',
          '\n%{http_code}',
          url,
        ],
        { encoding: 'utf-8' }
      );

      const splitAt = raw.lastIndexOf('\n');
      if (splitAt === -1) {
        throw new Error(`Unexpected curl response for ${url}`);
      }

      const body = raw.slice(0, splitAt);
      const statusCode = Number(raw.slice(splitAt + 1).trim());

      if (statusCode === 404) {
        return null;
      }
      if (!Number.isFinite(statusCode) || statusCode >= 400) {
        throw new Error(`HTTP ${statusCode} for ${url}`);
      }

      fs.mkdirSync(SOURCE_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath, body, 'utf-8');

      return body;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await delay(REQUEST_DELAY_MS * attempt);
    }
  }

  return null;
}

function parseFinlexXml(xml: string, fallbackId: string): ParsedStatute {
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
): Promise<void> {
  const { number, year } = parseStatuteId(statuteId);
  const canonicalNumber = normalizeCanonicalNumberToken(number);
  const canonicalId = options.canonicalStatuteId
    ? normalizeCanonicalStatuteId(options.canonicalStatuteId)
    : `${canonicalNumber}/${year}`;
  const fetchNumberToken = options.fetchNumberToken?.trim() || number;
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(SCRIPT_DIR, `../data/seed/${canonicalNumber}_${year}.json`);

  console.log('Finlex Data Ingestion');
  console.log(`  Statute: ${canonicalId}`);
  if (fetchNumberToken !== canonicalNumber) {
    console.log(`  Fetch key: ${fetchNumberToken}/${year}`);
  }
  console.log(`  Output:  ${targetPath}`);
  console.log('');

  const finXml = await fetchXml(year, fetchNumberToken, 'fin');

  if (!finXml) {
    throw new Error(`Could not fetch Finnish text for ${canonicalId} from Finlex.`);
  }

  let sweXml: string | null = null;
  try {
    await delay(REQUEST_DELAY_MS);
    sweXml = await fetchXml(year, fetchNumberToken, 'swe');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Warning: Swedish version fetch failed for ${canonicalId}: ${message}`);
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

  const seed: DocumentSeed = {
    id: normalizedParsedId || canonicalId,
    type: 'statute',
    title: fiParsed.title,
    title_en: svParsed?.title,
    short_name: SHORT_NAME_BY_ID[normalizedParsedId] ?? SHORT_NAME_BY_ID[canonicalId],
    status: 'in_force',
    issued_date: fiParsed.issuedDate,
    in_force_date: fiParsed.issuedDate,
    url: `${FINLEX_BASE}/${year}/${fetchNumberToken}/fin@`,
    description: `Ingested from Finlex open data (${fiParsed.category ?? 'statute'})`,
    provisions,
    provision_versions: provisions.map(p => ({
      ...p,
      valid_from: fiParsed.issuedDate,
      valid_to: null,
    })),
    definitions: definitions.length > 0 ? definitions : undefined,
    preparatory_works: preparatoryWorks.length > 0 ? preparatoryWorks : undefined,
  };

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(seed, null, 2), 'utf-8');

  console.log(`  Parsed provisions (FI): ${fiParsed.provisions.length}`);
  console.log(`  Parsed provisions (SV): ${svParsed?.provisions.length ?? 0}`);
  console.log(`  Definitions extracted:  ${definitions.length}`);
  console.log(`  Preparatory refs:       ${preparatoryWorks.length}`);
  console.log(`\n✅ Wrote seed file: ${targetPath}`);
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
