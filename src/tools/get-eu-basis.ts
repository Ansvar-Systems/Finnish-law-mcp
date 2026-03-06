/**
 * get_eu_basis — Retrieve EU legal basis for a Finnish statute.
 */

import type { Database } from '@ansvar/mcp-sqlite';
import type { EUBasisDocument } from '../types/index.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';
import { isValidStatuteId, resolveExistingStatuteId } from '../utils/statute-id.js';

export interface GetEUBasisInput {
  sfs_number: string;
  include_articles?: boolean;
  reference_types?: string[];
}

export interface GetEUBasisResult {
  sfs_number: string;
  sfs_title: string;
  eu_documents: EUBasisDocument[];
  statistics: {
    total_eu_references: number;
    directive_count: number;
    regulation_count: number;
  };
}

/**
 * Get EU legal basis for a Finnish statute.
 *
 * Returns all EU directives and regulations referenced by the given statute,
 * grouped by EU document with all article references aggregated.
 */
export async function getEUBasis(
  db: Database,
  input: GetEUBasisInput
): Promise<ToolResponse<GetEUBasisResult>> {
  // Validate statute identifier format
  if (!input.sfs_number || !isValidStatuteId(input.sfs_number)) {
    throw new Error(
      `Invalid SFS number format: "${input.sfs_number}". ` +
      `Expected "YYYY:NNN" (Sweden) or "NNN/YYYY" (Finland).`
    );
  }

  const resolvedStatuteId = resolveExistingStatuteId(db, input.sfs_number);

  // Check if statute exists
  if (!resolvedStatuteId) {
    throw new Error(`Statute ${input.sfs_number} not found in database`);
  }

  const statute = db.prepare(`
    SELECT id, title
    FROM legal_documents
    WHERE id = ? AND type = 'statute'
  `).get(resolvedStatuteId) as { id: string; title: string };

  // Build query for EU references
  let sql = `
    SELECT
      ed.id,
      ed.type,
      ed.year,
      ed.number,
      ed.community,
      ed.celex_number,
      ed.title,
      ed.short_name,
      ed.url_eur_lex,
      er.reference_type,
      er.is_primary_implementation,
      GROUP_CONCAT(DISTINCT er.eu_article) AS articles
    FROM eu_documents ed
    JOIN eu_references er ON ed.id = er.eu_document_id
    WHERE er.document_id = ?
  `;

  const params: (string | number)[] = [resolvedStatuteId];

  // Filter by reference types if specified
  if (input.reference_types && input.reference_types.length > 0) {
    const placeholders = input.reference_types.map(() => '?').join(', ');
    sql += ` AND er.reference_type IN (${placeholders})`;
    params.push(...input.reference_types);
  }

  sql += `
    GROUP BY ed.id
    ORDER BY
      er.is_primary_implementation DESC,
      CASE er.reference_type
        WHEN 'implements' THEN 1
        WHEN 'supplements' THEN 2
        WHEN 'applies' THEN 3
        ELSE 4
      END,
      ed.year DESC
  `;

  interface QueryRow {
    id: string;
    type: 'directive' | 'regulation';
    year: number;
    number: number;
    community: 'EU' | 'EG' | 'EEG' | 'Euratom';
    celex_number: string | null;
    title: string | null;
    short_name: string | null;
    url_eur_lex: string | null;
    reference_type: string;
    is_primary_implementation: number;
    articles: string | null;
  }

  const rows = db.prepare(sql).all(...params) as QueryRow[];

  // Transform rows into result format
  const euDocuments: EUBasisDocument[] = rows.map(row => {
    const doc: EUBasisDocument = {
      id: row.id,
      type: row.type,
      year: row.year,
      number: row.number,
      community: row.community,
      reference_type: row.reference_type as any,
      is_primary_implementation: row.is_primary_implementation === 1,
    };

    if (row.celex_number) doc.celex_number = row.celex_number;
    if (row.title) doc.title = row.title;
    if (row.short_name) doc.short_name = row.short_name;
    if (row.url_eur_lex) doc.url_eur_lex = row.url_eur_lex;

    // Parse articles if requested and available
    if (input.include_articles && row.articles) {
      doc.articles = row.articles.split(',').filter(a => a && a.trim());
    }

    return doc;
  });

  // Calculate statistics
  const directiveCount = euDocuments.filter(d => d.type === 'directive').length;
  const regulationCount = euDocuments.filter(d => d.type === 'regulation').length;

  const result: GetEUBasisResult = {
    sfs_number: statute.id,
    sfs_title: statute.title,
    eu_documents: euDocuments,
    statistics: {
      total_eu_references: euDocuments.length,
      directive_count: directiveCount,
      regulation_count: regulationCount,
    },
  };

  return {
    results: result,
    _metadata: generateResponseMetadata(db),
  };
}
