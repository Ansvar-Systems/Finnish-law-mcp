/**
 * Utilities for building robust FTS5 queries from natural-language input.
 *
 * If the user provides explicit FTS syntax (quotes, boolean operators, wildcards),
 * we preserve it. Otherwise we convert tokens to prefix terms so inflections like
 * "make" -> "maken" can match.
 */

import {
  extractLegalTokens,
  expandLegalQueryTokens,
  normalizeLegalText,
} from './legal-normalization.js';

const EXPLICIT_FTS_SYNTAX_PATTERN = /["*():^]|\bAND\b|\bOR\b|\bNOT\b/iu;

function sanitizeToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}_]/gu, '');
}

function escapeExplicitQuery(query: string): string {
  return query.replace(/[()^:]/g, (char) => `"${char}"`);
}

function buildPrefixAndQuery(tokens: string[]): string {
  return tokens.map(token => `${token}*`).join(' ');
}

function buildPrefixOrQuery(tokens: string[]): string {
  return tokens.map(token => `${token}*`).join(' OR ');
}

export interface FtsQueryVariants {
  primary: string;
  fallback?: string;
}

export function buildFtsQueryVariants(query: string): FtsQueryVariants {
  const trimmed = normalizeLegalText(query);
  if (!trimmed) {
    return { primary: '' };
  }

  if (EXPLICIT_FTS_SYNTAX_PATTERN.test(trimmed)) {
    return { primary: escapeExplicitQuery(trimmed) };
  }

  const tokens = extractLegalTokens(trimmed)
    .map(sanitizeToken)
    .filter(token => token.length > 1);
  if (tokens.length === 0) {
    return { primary: escapeExplicitQuery(trimmed) };
  }

  const primary = buildPrefixAndQuery(tokens);
  const expandedTokens = expandLegalQueryTokens(tokens)
    .map(sanitizeToken)
    .filter(token => token.length > 1);

  const fallbackTokens = expandedTokens.length > 0 ? expandedTokens : tokens;
  const fallback = buildPrefixOrQuery(fallbackTokens);

  if (tokens.length === 1 && fallback === primary) {
    return { primary };
  }

  return {
    primary,
    fallback,
  };
}
