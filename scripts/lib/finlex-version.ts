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

  // Single-version consolidations are served with a BARE '@' FRBRuri — the
  // ambiguous form this module's header forbids (a bare '@' on the
  // consolidated doctype re-resolves to the OLDEST expression once a second
  // version appears). The version number sits in the same identification
  // block, so pin the identity: '…/fin@' + '20050045' addresses the exact
  // expression that was served.
  const pinnedExpressionUri =
    versionNumber !== null && expressionUri.endsWith('@')
      ? `${expressionUri}${versionNumber}`
      : expressionUri;

  return {
    doc_type: docTypeMatch[1] as FinlexDocType,
    expression_uri: pinnedExpressionUri,
    version_number: versionNumber,
    consolidated_to: consolidatedTo,
    eli_uri: eliUri,
    language: langAndVersion[1],
    contains: containsMatch?.[1] ?? 'unknown',
  };
}

/**
 * Lifecycle facts Finlex publishes in the <proprietary> block of consolidated
 * expressions (finlex:isInForce, finlex:inForce, finlex:repealedBy).
 * As-enacted (alkup) expressions carry none of these — `is_in_force` is null
 * for them ("no fact published"), never a guessed boolean.
 */
export interface StatuteLifecycle {
  /** finlex:isInForce value; null when upstream publishes no lifecycle metadata. */
  is_in_force: boolean | null;
  /** Top-level finlex:inForce/dateEntryIntoForce (NOT the nested per-amendment ones). */
  date_entry_into_force: string | null;
  /** finlex:inForce/dateInForceEnd — the day the act ceased to be in force. */
  date_in_force_end: string | null;
  /** Statute ids (e.g. '1050/2018') from finlex:repealedBy references. */
  repealed_by: string[];
}

function refToStatuteId(ref: unknown): string | null {
  if (typeof ref === 'string') return ref.trim();
  if (typeof ref !== 'object' || ref === null) return null;
  const node = ref as Record<string, unknown>;
  const text = node['#text'];
  if (typeof text === 'string' && text.trim()) return text.trim();
  const href = node['@_href'];
  if (typeof href === 'string') {
    const match = href.match(/\/(\d{4})\/(\d+)$/u);
    if (match) return `${match[2]}/${match[1]}`;
  }
  return null;
}

/**
 * Parse the finlex lifecycle metadata from an AKN document. Reads only the
 * TOP-LEVEL <proprietary> children — finlex:amendedBy / finlex:repealedBy
 * statute references carry their own nested finlex:inForce blocks which must
 * not be mistaken for the document's own lifecycle.
 *
 * Unknown isInForce vocabulary fails loud — a lifecycle value we cannot
 * interpret must never silently become a status claim.
 */
export function parseLifecycle(xml: string): StatuteLifecycle {
  const empty: StatuteLifecycle = {
    is_in_force: null,
    date_entry_into_force: null,
    date_in_force_end: null,
    repealed_by: [],
  };

  const start = xml.indexOf('<proprietary');
  const end = xml.indexOf('</proprietary>');
  if (start === -1 || end === -1) return empty;

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml.slice(start, end + '</proprietary>'.length)) as Record<
    string,
    unknown
  >;
  const proprietary = parsed.proprietary as Record<string, unknown> | undefined;
  if (!proprietary) return empty;

  let isInForce: boolean | null = null;
  const isInForceNode = proprietary['finlex:isInForce'] as Record<string, unknown> | undefined;
  const isInForceValue = attr(isInForceNode, '@_value');
  if (isInForceNode !== undefined) {
    if (isInForceValue === 'true') {
      isInForce = true;
    } else if (isInForceValue === 'false') {
      isInForce = false;
    } else {
      throw new Error(
        `Unknown finlex:isInForce value "${isInForceValue ?? '(none)'}" — refusing to derive a status from vocabulary drift`
      );
    }
  }

  let dateEntryIntoForce: string | null = null;
  let dateInForceEnd: string | null = null;
  for (const inForce of asArray(proprietary['finlex:inForce'] as Record<string, unknown> | Record<string, unknown>[])) {
    const entry = asArray(inForce['finlex:dateEntryIntoForce'] as Record<string, unknown> | Record<string, unknown>[])[0];
    const entryDate = attr(entry, '@_date');
    if (entryDate) dateEntryIntoForce = entryDate;
    const endNode = asArray(inForce['finlex:dateInForceEnd'] as Record<string, unknown> | Record<string, unknown>[])[0];
    const endDate = attr(endNode, '@_date');
    if (endDate) dateInForceEnd = endDate;
  }

  const repealedBy: string[] = [];
  for (const block of asArray(proprietary['finlex:repealedBy'] as Record<string, unknown> | Record<string, unknown>[])) {
    for (const reference of asArray(block['finlex:statuteReference'] as Record<string, unknown> | Record<string, unknown>[])) {
      const id = refToStatuteId(reference['finlex:ref']);
      if (id) repealedBy.push(id);
    }
  }

  return {
    is_in_force: isInForce,
    date_entry_into_force: dateEntryIntoForce,
    date_in_force_end: dateInForceEnd,
    repealed_by: repealedBy,
  };
}

export type SeedStatus = 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';

export type StatusBasis = 'finlex_lifecycle_metadata' | 'as_enacted_default_unverified';

/**
 * Derive the seed status from upstream lifecycle facts.
 *
 *   - isInForce=true               -> in_force
 *   - isInForce=false, future
 *     entry-into-force date        -> not_yet_in_force
 *   - isInForce=false otherwise    -> repealed (covers explicit repealedBy AND
 *     expiry via dateInForceEnd — the seed schema has no 'expired' value; the
 *     precise facts are preserved in the _ingest.lifecycle stamp)
 *   - no lifecycle on a CONSOLIDATED document -> throw (every probed
 *     consolidated expression carries finlex:isInForce; absence is shape
 *     drift, not a fact)
 *   - no lifecycle on an AS-ENACTED document -> 'in_force' stamped
 *     'as_enacted_default_unverified'. Finlex publishes no machine-readable
 *     lifecycle state on alkup expressions, and statutes without a
 *     consolidated counterpart (~60% of the corpus: amendment acts, treaty
 *     implementation acts) have no other upstream signal. The default keeps
 *     the corpus serving; the stamped basis makes the unverified claim
 *     auditable instead of indistinguishable from a proven fact.
 */
export function deriveSeedStatus(opts: {
  docType: FinlexDocType;
  lifecycle: StatuteLifecycle;
  /** ISO date used for the not_yet_in_force comparison; defaults to today. */
  today?: string;
}): { status: SeedStatus; basis: StatusBasis } {
  const { docType, lifecycle } = opts;
  if (lifecycle.is_in_force === null) {
    if (docType === 'statute-consolidated') {
      throw new Error(
        'Consolidated expression carries no finlex:isInForce lifecycle metadata — shape drift, refusing to invent a status'
      );
    }
    return { status: 'in_force', basis: 'as_enacted_default_unverified' };
  }
  if (lifecycle.is_in_force) {
    return { status: 'in_force', basis: 'finlex_lifecycle_metadata' };
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (lifecycle.date_entry_into_force !== null && lifecycle.date_entry_into_force > today) {
    return { status: 'not_yet_in_force', basis: 'finlex_lifecycle_metadata' };
  }
  return { status: 'repealed', basis: 'finlex_lifecycle_metadata' };
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
  | 'skip_current'
  /** Upstream served an expression OLDER than the stamp — keep the newer seed. */
  | 'stale_upstream';

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
 * already holds the fetched version. A fetched expression OLDER than the
 * stamp is a stale-upstream anomaly (fin@latest sits behind a ~10-min
 * server-side cache): the stamp proves a newer consolidation was served
 * before, so rewriting would destroy newer text — refuse and surface it.
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
  return 'stale_upstream';
}

export interface LanguageStamp {
  expression_uri: string;
  consolidation_version: string | null;
}

/** Consolidated shell published with an empty body (<hcontainer name="contentAbsent"/>). */
export interface ContentAbsentStamp {
  version: string | null;
  consolidated_to: string | null;
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
  /** Upstream lifecycle facts the seed status was derived from. */
  lifecycle?: StatuteLifecycle;
  /** How the seed status was established (proven fact vs documented default). */
  status_basis?: StatusBasis;
  /**
   * Set when the consolidated expression exists upstream but its body is an
   * empty contentAbsent shell: the seed text is the as-enacted original, used
   * as an EXPLICIT, stamped fallback (never a silent overwrite with nothing).
   */
  consolidated_content_absent?: ContentAbsentStamp;
}

export function buildIngestStamp(opts: {
  now: string;
  primary: VersionIdentity;
  languages: Record<string, VersionIdentity>;
  lifecycle?: StatuteLifecycle;
  statusBasis?: StatusBasis;
  consolidatedContentAbsent?: ContentAbsentStamp;
}): IngestStamp {
  const languages: Record<string, LanguageStamp> = {};
  for (const [lang, identity] of Object.entries(opts.languages)) {
    languages[lang] = {
      expression_uri: identity.expression_uri,
      consolidation_version: identity.version_number,
    };
  }
  const stamp: IngestStamp = {
    retrieved_at: opts.now,
    source: 'finlex-opendata',
    doc_type: opts.primary.doc_type,
    expression_uri: opts.primary.expression_uri,
    consolidation_version: opts.primary.version_number,
    consolidated_to: opts.primary.consolidated_to,
    eli_uri: opts.primary.eli_uri,
    languages,
  };
  if (opts.lifecycle) stamp.lifecycle = opts.lifecycle;
  if (opts.statusBasis) stamp.status_basis = opts.statusBasis;
  if (opts.consolidatedContentAbsent) stamp.consolidated_content_absent = opts.consolidatedContentAbsent;
  return stamp;
}

/** Read the stamped consolidation version from an existing seed file's parsed JSON. */
export function stampedVersionOf(seed: unknown): string | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const ingest = (seed as Record<string, unknown>)._ingest;
  if (typeof ingest !== 'object' || ingest === null) return null;
  const version = (ingest as Record<string, unknown>).consolidation_version;
  return typeof version === 'string' ? version : null;
}

/**
 * Per-language stamped consolidation versions, or null when the seed carries
 * no stamp. A seed whose Swedish entry is missing was written with Swedish
 * omitted (not available / version mismatch) and must be re-examined on
 * refresh — the Finnish version alone does not prove the seed is complete.
 */
export function stampedLanguageVersionsOf(seed: unknown): Record<string, string | null> | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const ingest = (seed as Record<string, unknown>)._ingest;
  if (typeof ingest !== 'object' || ingest === null) return null;
  const languages = (ingest as Record<string, unknown>).languages;
  if (typeof languages !== 'object' || languages === null) return null;
  const result: Record<string, string | null> = {};
  for (const [lang, entry] of Object.entries(languages as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const version = (entry as Record<string, unknown>).consolidation_version;
    result[lang] = typeof version === 'string' ? version : null;
  }
  return result;
}

export interface SeedStampInfo {
  doc_type: FinlexDocType | null;
  consolidation_version: string | null;
  /** Version of the empty consolidated shell, when the seed fell back to the original. */
  content_absent_version: string | null;
}

/**
 * Full stamp identity for freshness classification. Distinguishes
 * stamped-as-enacted (doc_type 'statute', consolidation_version null — the
 * legitimate consolidated-404 cohort, freshness PROVEN) from unstamped
 * (no _ingest at all — freshness unprovable). Collapsing both to "no version"
 * was the check-updates:241 defect.
 */
export function seedStampInfoOf(seed: unknown): SeedStampInfo | null {
  if (typeof seed !== 'object' || seed === null) return null;
  const ingest = (seed as Record<string, unknown>)._ingest;
  if (typeof ingest !== 'object' || ingest === null) return null;
  const record = ingest as Record<string, unknown>;
  const docType = record.doc_type;
  const version = record.consolidation_version;
  const contentAbsent = record.consolidated_content_absent;
  let contentAbsentVersion: string | null = null;
  if (typeof contentAbsent === 'object' && contentAbsent !== null) {
    const v = (contentAbsent as Record<string, unknown>).version;
    contentAbsentVersion = typeof v === 'string' ? v : null;
  }
  return {
    doc_type: docType === 'statute' || docType === 'statute-consolidated' ? docType : null,
    consolidation_version: typeof version === 'string' ? version : null,
    content_absent_version: contentAbsentVersion,
  };
}
