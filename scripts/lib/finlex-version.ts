/**
 * Version identity + version-keyed refresh policy for the Finlex open-data
 * acquisition (issue #78, port of dutch-law-mcp src/ingest/{toestand,refresh-policy}.ts).
 *
 * Finlex AKN version semantics (verified against the live API + OpenAPI spec,
 * 2026-06-10):
 *
 *   - act/statute/{y}/{n}/{lang}@           -> ORIGINAL as-enacted text
 *     (ELI alias .../alkup, <act contains="originalVersion">). This is the URL
 *     the pre-fix pipeline used for the WHOLE corpus: every seed carried
 *     as-enacted text, missing all later amendments.
 *   - act/statute-consolidated/{y}/{n}/{lang}@{VER} -> consolidation
 *     (ELI alias .../ajantasa). VER is YYYYNNNN: year + zero-padded number of
 *     the newest amending statute incorporated. A BARE `@` on the consolidated
 *     doctype resolves to the OLDEST expression, so it must never be used.
 *   - {lang}@latest -> the NEWEST version (documented in the OpenAPI spec;
 *     ~10 min server-side cache). This is the only safe acquisition token.
 *
 * Whenever freshness cannot be PROVEN (no stamp, unparseable values, upstream
 * older than stamp) the policy refetches — never a silent skip.
 */

import { XMLParser } from 'fast-xml-parser';

export const FINLEX_API_BASE = 'https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act';

export type FinlexDocType = 'statute' | 'statute-consolidated';

export interface VersionIdentity {
  /** Upstream document type the expression was actually served from. */
  doc_type: FinlexDocType;
  /** Version-pinned expression URI, e.g. '/akn/fi/act/statute-consolidated/2018/1050/fin@20260380'. */
  expression_uri: string;
  /** Consolidation version token (FRBRversionNumber, YYYYNNNN); null for as-enacted originals. */
  version_number: string | null;
  /** Point-in-time date of the consolidation (FRBRdate name="dateConsolidated"); null for originals. */
  consolidated_to: string | null;
  /** ELI alias of the expression (…/ajantasa/… or …/alkup/…). */
  eli_uri: string | null;
  /** ISO 639-2 language of the expression ('fin' / 'swe'). */
  language: string;
  /** AKN <act contains> attribute ('originalVersion' / 'multipleVersions' / 'singleVersion'). */
  contains: string;
}

interface FrbrDateNode {
  '@_date'?: string;
  '@_name'?: string;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: Record<string, unknown> | undefined, name: string): string | null {
  const value = node?.[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Extract the FRBR version identity from a Finlex AKN document.
 * Throws when the identification block is missing or incomplete — a document
 * whose version cannot be established must not be ingested.
 */
export function parseVersionIdentity(xml: string): VersionIdentity {
  // The identification block sits in the first ~3KB; slice before parsing so
  // multi-MB statute bodies are not parsed twice.
  const start = xml.indexOf('<identification');
  const end = xml.indexOf('</identification>');
  if (start === -1 || end === -1) {
    throw new Error('Finlex AKN document has no <identification> block — cannot establish version identity');
  }
  const containsMatch = xml.match(/<act\s[^>]*contains="([^"]+)"/u);

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml.slice(start, end + '</identification>'.length)) as Record<
    string,
    unknown
  >;
  const identification = parsed.identification as Record<string, unknown> | undefined;
  const expression = identification?.FRBRExpression as Record<string, unknown> | undefined;
  if (!expression) {
    throw new Error('Finlex AKN identification block has no FRBRExpression — cannot establish version identity');
  }

  const expressionUri = attr(expression.FRBRuri as Record<string, unknown>, '@_value');
  if (!expressionUri) {
    throw new Error('FRBRExpression has no FRBRuri — cannot establish version identity');
  }

  const docTypeMatch = expressionUri.match(/\/act\/(statute-consolidated|statute)\//u);
  if (!docTypeMatch) {
    throw new Error(`FRBRExpression URI "${expressionUri}" is not a statute expression`);
  }

  const langAndVersion = expressionUri.match(/\/([a-z]{3})@([0-9a-zA-Z]*)$/u);
  if (!langAndVersion) {
    throw new Error(`FRBRExpression URI "${expressionUri}" has no {lang}@{version} segment`);
  }

  let consolidatedTo: string | null = null;
  for (const dateNode of asArray(expression.FRBRdate as FrbrDateNode | FrbrDateNode[])) {
    if (dateNode['@_name'] === 'dateConsolidated' && typeof dateNode['@_date'] === 'string') {
      consolidatedTo = dateNode['@_date'];
    }
  }

  let eliUri: string | null = null;
  for (const alias of asArray(expression.FRBRalias as Record<string, unknown> | Record<string, unknown>[])) {
    if (attr(alias, '@_name') === 'eli') {
      eliUri = attr(alias, '@_value');
    }
  }

  const versionNumber = attr(expression.FRBRversionNumber as Record<string, unknown>, '@_value');

  return {
    doc_type: docTypeMatch[1] as FinlexDocType,
    expression_uri: expressionUri,
    version_number: versionNumber,
    consolidated_to: consolidatedTo,
    eli_uri: eliUri,
    language: langAndVersion[1],
    contains: containsMatch?.[1] ?? 'unknown',
  };
}

/**
 * Defense against the issue-#78 defect class: refuse to treat an as-enacted
 * (alkup) expression as the current consolidation.
 */
export function assertCurrentConsolidation(identity: VersionIdentity): void {
  if (identity.doc_type !== 'statute-consolidated') {
    throw new Error(
      `Expected a consolidated (ajantasa) expression but got doc_type="${identity.doc_type}" ` +
        `(${identity.expression_uri}) — original/alkup text must never be stamped as current`
    );
  }
  if (identity.eli_uri && !identity.eli_uri.includes('/ajantasa')) {
    throw new Error(
      `Consolidated expression ${identity.expression_uri} carries a non-ajantasa ELI alias ` +
        `(${identity.eli_uri}) — refusing to stamp it as the current consolidation`
    );
  }
}

const VERSION_TOKEN_RE = /^\d{8}$/u;

/**
 * Compare two YYYYNNNN consolidation tokens. Lexical order IS chronological
 * order (fixed 8 digits; statute numbers are assigned chronologically within
 * a year and zero-padded to 4 digits). Throws on malformed tokens.
 */
export function compareVersionNumbers(a: string, b: string): number {
  if (!VERSION_TOKEN_RE.test(a) || !VERSION_TOKEN_RE.test(b)) {
    throw new Error(`Malformed consolidation version token(s): "${a}" / "${b}" (expected YYYYNNNN)`);
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export type FetchDecision =
  | 'fetch_new'
  | 'skip_existing'
  | 'refetch_unknown'
  | 'refetch_check'
  | 'refetch_changed'
  | 'skip_current';

/**
 * Pre-network decision. With Finlex the newest-version probe IS the document
 * fetch (`fin@latest`), so a stamped seed in refresh mode resolves to
 * 'refetch_check': fetch, then let decideRewrite() decide whether to write.
 */
export function decideFetch(opts: {
  seedExists: boolean;
  refresh: boolean;
  stampedVersion: string | null;
}): FetchDecision {
  if (!opts.seedExists) return 'fetch_new';
  if (!opts.refresh) return 'skip_existing';
  // A seed without a consolidation stamp predates newest-version acquisition
  // and may hold as-enacted content. Self-heal is unconditional.
  if (!opts.stampedVersion || !VERSION_TOKEN_RE.test(opts.stampedVersion)) return 'refetch_unknown';
  return 'refetch_check';
}

/**
 * Post-fetch decision: rewrite the seed unless the stamp PROVES the seed
 * already holds the fetched version.
 */
export function decideRewrite(opts: {
  stampedVersion: string | null;
  fetchedVersion: string | null;
}): FetchDecision {
  const stampedValid = opts.stampedVersion !== null && VERSION_TOKEN_RE.test(opts.stampedVersion);
  const fetchedValid = opts.fetchedVersion !== null && VERSION_TOKEN_RE.test(opts.fetchedVersion);
  if (!stampedValid || !fetchedValid) return 'refetch_unknown';
  const cmp = compareVersionNumbers(opts.fetchedVersion as string, opts.stampedVersion as string);
  if (cmp > 0) return 'refetch_changed';
  if (cmp === 0) return 'skip_current';
  return 'refetch_unknown';
}

export interface LanguageStamp {
  expression_uri: string;
  consolidation_version: string | null;
}

export interface IngestStamp {
  retrieved_at: string;
  source: 'finlex-opendata';
  doc_type: FinlexDocType;
  expression_uri: string;
  consolidation_version: string | null;
  consolidated_to: string | null;
  eli_uri: string | null;
  languages: Record<string, LanguageStamp>;
}

export function buildIngestStamp(opts: {
  now: string;
  primary: VersionIdentity;
  languages: Record<string, VersionIdentity>;
}): IngestStamp {
  const languages: Record<string, LanguageStamp> = {};
  for (const [lang, identity] of Object.entries(opts.languages)) {
    languages[lang] = {
      expression_uri: identity.expression_uri,
      consolidation_version: identity.version_number,
    };
  }
  return {
    retrieved_at: opts.now,
    source: 'finlex-opendata',
    doc_type: opts.primary.doc_type,
    expression_uri: opts.primary.expression_uri,
    consolidation_version: opts.primary.version_number,
    consolidated_to: opts.primary.consolidated_to,
    eli_uri: opts.primary.eli_uri,
    languages,
  };
}

/** Read the stamped consolidation version from an existing seed file's parsed JSON. */
export function stampedVersionOf(seed: unknown): string | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const ingest = (seed as Record<string, unknown>)._ingest;
  if (typeof ingest !== 'object' || ingest === null) return null;
  const version = (ingest as Record<string, unknown>).consolidation_version;
  return typeof version === 'string' ? version : null;
}
