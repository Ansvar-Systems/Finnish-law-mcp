/**
 * Domain types for Finnish legal documents.
 */

/** Types of legal documents in the Finnish system */
export type DocumentType = 'statute' | 'bill' | 'sou' | 'ds' | 'case_law';

/** Status of a legal document */
export type DocumentStatus = 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';

/** Finnish court types */
export type CourtType =
  | 'KKO'                // Korkein oikeus (Supreme Court)
  | 'KHO'                // Korkein hallinto-oikeus (Supreme Administrative Court)
  | 'hovioikeus'          // Court of Appeal
  | 'hallinto-oikeus'     // Administrative Court
  | 'käräjäoikeus'        // District Court
  | 'markkinaoikeus'      // Market Court
  | 'työtuomioistuin'     // Labour Court
  | 'vakuutusoikeus';     // Insurance Court

/** A legal document in the Finnish system */
export interface LegalDocument {
  /** Statute number (e.g., "1050/2018"), case reference, or prop number */
  id: string;

  /** Document type */
  type: DocumentType;

  /** Finnish title */
  title: string;

  /** English title if available */
  title_en?: string;

  /** Short name / abbreviation (e.g., "TSL", "RL") */
  short_name?: string;

  /** Current status */
  status: DocumentStatus;

  /** Issuing date (ISO 8601) */
  issued_date?: string;

  /** Date entering into force */
  in_force_date?: string;

  /** URL to official source */
  url?: string;

  /** Summary / description */
  description?: string;
}
