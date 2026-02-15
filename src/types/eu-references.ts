/**
 * EU References Types
 *
 * Types for EU law cross-references in Swedish legislation.
 */

export type EUDocumentType = 'directive' | 'regulation';

export type EUCommunity = 'EU' | 'EG' | 'EEG' | 'Euratom';

export type ReferenceType =
  | 'implements'          // Swedish law implements this EU directive
  | 'supplements'         // Swedish law supplements this EU regulation
  | 'applies'             // This EU regulation applies directly
  | 'references'          // General reference to EU law
  | 'complies_with'       // Swedish law must comply with this
  | 'derogates_from'      // Swedish law derogates from this (allowed by EU law)
  | 'amended_by'          // Swedish law was amended to implement this
  | 'repealed_by'         // Swedish law was repealed by this EU act
  | 'cites_article';      // Cites specific article(s) of EU act

export type ImplementationStatus = 'complete' | 'partial' | 'pending' | 'unknown';

export interface EUDocument {
  id: string;                    // "directive:2016/679" or "regulation:2016/679"
  type: EUDocumentType;
  year: number;
  number: number;
  community: EUCommunity;
  celex_number?: string;         // "32016R0679"
  title?: string;
  title_sv?: string;
  short_name?: string;           // "GDPR"
  adoption_date?: string;
  entry_into_force_date?: string;
  in_force: boolean;
  amended_by?: string;           // JSON array
  repeals?: string;              // JSON array
  url_eur_lex?: string;
  description?: string;
  last_updated?: string;
}

export interface EUReference {
  id: number;
  source_type: 'provision' | 'document' | 'case_law';
  source_id: string;
  document_id: string;           // SFS number
  provision_id?: number;
  eu_document_id: string;
  eu_article?: string;           // "6.1.c", "13-15", etc.
  reference_type: ReferenceType;
  reference_context?: string;
  full_citation?: string;
  is_primary_implementation: boolean;
  implementation_status?: ImplementationStatus;
  created_at?: string;
  last_verified?: string;
}

export interface EUBasisDocument {
  id: string;
  type: EUDocumentType;
  year: number;
  number: number;
  community: EUCommunity;
  celex_number?: string;
  title?: string;
  short_name?: string;
  reference_type: ReferenceType;
  is_primary_implementation: boolean;
  articles?: string[];
  url_eur_lex?: string;
}

export interface SwedishImplementation {
  sfs_number: string;
  sfs_title: string;
  short_name?: string;
  status: string;
  reference_type: ReferenceType;
  is_primary_implementation: boolean;
  implementation_status?: ImplementationStatus;
  articles_referenced?: string[];
}

export interface FinnishImplementation extends SwedishImplementation {}

export interface ProvisionEUReference {
  id: string;
  type: EUDocumentType;
  title?: string;
  short_name?: string;
  article?: string;
  reference_type: ReferenceType;
  full_citation: string;
  context?: string;
}
