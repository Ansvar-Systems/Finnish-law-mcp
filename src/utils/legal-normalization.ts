/**
 * Utility helpers for normalizing Finnish and Swedish legal text variants.
 *
 * Goals:
 * - Normalize whitespace and section markers for stable indexing/querying
 * - Expand common FI/SV legal terminology into cross-language search variants
 * - Support flexible chapter/section/provision inputs
 */

const WHITESPACE_PATTERN = /\s+/gu;
const SECTION_MARKER_PATTERN = /(?:§+|pyk[aä]l[aä]|paragraf(?:en)?|section)/giu;
const CHAPTER_WORD_PATTERN = /(?:luku|kapitel|kap\.?|chapter)/giu;

const LEGAL_TERM_VARIANTS: Record<string, string[]> = {
  laki: ['lag', 'act'],
  lag: ['laki', 'act'],
  asetus: ['forordning', 'förordning', 'regulation'],
  forordning: ['asetus', 'regulation'],
  forordningen: ['asetus', 'regulation'],
  luku: ['kapitel', 'chapter'],
  kapitel: ['luku', 'chapter'],
  pykala: ['pykälä', 'paragraf', 'section'],
  pykalaa: ['paragraf', 'section'],
  pykalaan: ['paragraf', 'section'],
  paragraf: ['pykälä', 'pykala', 'section'],
  momentti: ['mom', 'stycke', 'subsection'],
  mom: ['momentti', 'stycke'],
  tietosuoja: ['dataskydd', 'gdpr', 'privacy'],
  dataskydd: ['tietosuoja', 'gdpr', 'privacy'],
  henkilotieto: ['henkilötieto', 'personuppgift', 'personaldata'],
  personuppgift: ['henkilötieto', 'henkilotieto', 'personaldata'],
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function foldNordicText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();
}

export function normalizeLegalText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s*§+\s*/gu, ' § ')
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

export function extractLegalTokens(query: string): string[] {
  const normalized = normalizeLegalText(query);
  const matches = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return matches.map(token => token.toLowerCase());
}

export function expandLegalQueryTokens(tokens: string[]): string[] {
  const expanded = new Set<string>();

  for (const token of tokens) {
    if (!token) continue;
    const folded = foldNordicText(token);
    expanded.add(token);
    expanded.add(folded);

    for (const variant of asArray(LEGAL_TERM_VARIANTS[folded])) {
      expanded.add(variant);
      expanded.add(foldNordicText(variant));
    }
  }

  return [...expanded].filter(token => token.length > 0);
}

export function normalizeChapterToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(CHAPTER_WORD_PATTERN, '')
    .replace(/[^\d]/gu, '')
    .trim();
}

export function normalizeSectionToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(SECTION_MARKER_PATTERN, '')
    .replace(/[^\d\sa-z]/gu, '')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

/**
 * Accepts a flexible provision expression and returns canonical `chapter:section`
 * or `section` format used by the database.
 */
export function normalizeProvisionReference(input: string): string {
  const raw = normalizeLegalText(input.toLowerCase());

  // Common compact form: 3:5
  const compact = raw.match(/^(\d+)\s*:\s*(\d+\s*[a-z]?)$/iu);
  if (compact) {
    return `${compact[1]}:${compact[2].replace(/\s+/gu, ' ').trim()}`;
  }

  // Worded chapter/section forms:
  // "3 luku 5 §", "3 kap. 5 §", "3 chapter 5 section"
  const worded = raw.match(
    /(\d+)\s*(?:luku|kapitel|kap\.?|chapter)\s*(\d+\s*[a-z]?)\s*(?:§|pyk[aä]l[aä]|paragraf(?:en)?|section)?/iu
  );
  if (worded) {
    return `${worded[1]}:${worded[2].replace(/\s+/gu, ' ').trim()}`;
  }

  // Flat provision form: "5 §", "5 a pykälä"
  return normalizeSectionToken(raw);
}
