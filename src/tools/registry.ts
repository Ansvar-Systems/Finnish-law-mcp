/**
 * Tool registry for Finnish Legal Citation MCP Server.
 * Shared between stdio (index.ts) and HTTP (api/mcp.ts) entry points.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import Database from '@ansvar/mcp-sqlite';

import { searchLegislation, SearchLegislationInput } from './search-legislation.js';
import { getProvision, GetProvisionInput } from './get-provision.js';
import { searchCaseLaw, SearchCaseLawInput } from './search-case-law.js';
import { getPreparatoryWorks, GetPreparatoryWorksInput } from './get-preparatory-works.js';
import { validateCitationTool, ValidateCitationInput } from './validate-citation.js';
import { buildLegalStance, BuildLegalStanceInput } from './build-legal-stance.js';
import { formatCitationTool, FormatCitationInput } from './format-citation.js';
import { checkCurrency, CheckCurrencyInput } from './check-currency.js';
import { getEUBasis, GetEUBasisInput } from './get-eu-basis.js';
import { getFinnishImplementations, GetFinnishImplementationsInput } from './get-finnish-implementations.js';
import { searchEUImplementations, SearchEUImplementationsInput } from './search-eu-implementations.js';
import { getProvisionEUBasis, GetProvisionEUBasisInput } from './get-provision-eu-basis.js';
import { validateEUCompliance, ValidateEUComplianceInput } from './validate-eu-compliance.js';
import { getAbout, type AboutContext } from './about.js';
import { listSources } from './list-sources.js';
import { getProvisionAtDate, GetProvisionAtDateParams, toolDefinition as provisionAtDateDef } from './get-provision-at-date.js';
export type { AboutContext } from './about.js';

const ABOUT_TOOL: Tool = {
  name: 'about',
  description:
    'Server metadata, dataset statistics, freshness, and provenance. ' +
    'Call this to verify data coverage, currency, and content basis before relying on results.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const TOOLS: Tool[] = [
  {
    name: 'search_legislation',
    description: `Search Finnish statutes and regulations by keyword.

Searches provision text using FTS5 with BM25 ranking. Supports boolean operators (AND, OR, NOT), phrase search ("exact phrase"), and prefix matching (term*).

Returns matched provisions with snippets, relevance scores, and document metadata.

When NOT to use: If you already know the exact statute number and provision, use get_provision instead. If you need a comprehensive multi-source answer, use build_legal_stance.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in Finnish or English. Supports FTS5 syntax.' },
        document_id: { type: 'string', description: 'Filter to a specific statute by statute number (e.g., "1050/2018" or "2018:218")' },
        status: { type: 'string', enum: ['in_force', 'amended', 'repealed'], description: 'Filter by document status' },
        as_of_date: { type: 'string', description: 'Optional historical date filter (YYYY-MM-DD).' },
        limit: { type: 'number', description: 'Maximum results', default: 10, minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provision',
    description: `Retrieve a specific provision from a Finnish statute.

Specify the statute number and either chapter+section or provision_ref directly.

When NOT to use: If you are searching by keyword and don't know the exact statute/provision, use search_legislation instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
        chapter: { type: 'string', description: 'Chapter number (e.g., "3").' },
        section: { type: 'string', description: 'Section number (e.g., "5", "5 a")' },
        provision_ref: { type: 'string', description: 'Direct provision reference (e.g., "3:5")' },
        as_of_date: { type: 'string', description: 'Optional historical date (YYYY-MM-DD).' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'search_case_law',
    description: `Search Finnish court decisions (oikeustapaukset). Filter by court (KKO, KHO, hovioikeus, etc.) and date range.

When NOT to use: If you need statute text, use search_legislation. Case law searches only cover court decisions.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for case law summaries' },
        court: { type: 'string', description: 'Filter by court (e.g., "KKO", "KHO", "hovioikeus")' },
        date_from: { type: 'string', description: 'Start date filter (ISO 8601)' },
        date_to: { type: 'string', description: 'End date filter (ISO 8601)' },
        limit: { type: 'number', description: 'Maximum results', default: 10, minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_preparatory_works',
    description: `Get preparatory works (esityöt) for a Finnish statute. Returns linked government proposals (HE), committee reports, and related documents.

When NOT to use: If you need the statute text itself, use get_provision. Preparatory works explain legislative intent, not current law.`,
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'validate_citation',
    description: `Validate a Finnish legal citation against the database. Parses the citation, checks existence, and returns warnings.

When NOT to use: If you want to format a citation string, use format_citation. This tool checks existence in the database.`,
    inputSchema: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: 'Citation string to validate' },
      },
      required: ['citation'],
    },
  },
  {
    name: 'build_legal_stance',
    description: `Build a comprehensive set of citations for a legal question. Searches across statutes, case law, and preparatory works.

When NOT to use: If you need a specific provision or targeted search, use get_provision or search_legislation instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Legal question or topic to research' },
        document_id: { type: 'string', description: 'Optionally limit statute search to one document' },
        include_case_law: { type: 'boolean', description: 'Include case law results (default: true)' },
        include_preparatory_works: { type: 'boolean', description: 'Include preparatory works results (default: true)' },
        as_of_date: { type: 'string', description: 'Optional historical date (YYYY-MM-DD).' },
        limit: { type: 'number', description: 'Max results per category', default: 5, minimum: 1, maximum: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'format_citation',
    description: `Format a Finnish legal citation per standard conventions (full, short, or pinpoint).

When NOT to use: If you want to check whether a citation exists in the database, use validate_citation instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: 'Citation string to format' },
        format: { type: 'string', enum: ['full', 'short', 'pinpoint'], description: 'Output format (default: "full")' },
      },
      required: ['citation'],
    },
  },
  {
    name: 'check_currency',
    description: `Check if a Finnish statute or provision is in force (current or historical).

When NOT to use: If you need the actual text of a provision, use get_provision. This tool only checks status.`,
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
        provision_ref: { type: 'string', description: 'Optional provision reference (e.g., "3:5")' },
        as_of_date: { type: 'string', description: 'Optional historical date (YYYY-MM-DD).' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'get_eu_basis',
    description: `Get EU legal basis (directives and regulations) for a Finnish statute.

When NOT to use: For provision-level EU references, use get_provision_eu_basis. To find Finnish laws implementing EU law, use get_finnish_implementations.`,
    inputSchema: {
      type: 'object',
      properties: {
        sfs_number: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
        include_articles: { type: 'boolean', description: 'Include specific EU article references (default: false)' },
        reference_types: { type: 'array', items: { type: 'string' }, description: 'Filter by reference type' },
      },
      required: ['sfs_number'],
    },
  },
  {
    name: 'get_finnish_implementations',
    description: `Find Finnish statutes implementing a specific EU directive or regulation.

When NOT to use: If you have a Finnish statute and want its EU basis, use get_eu_basis (opposite direction).`,
    inputSchema: {
      type: 'object',
      properties: {
        eu_document_id: { type: 'string', description: 'EU document ID (e.g., "regulation:2016/679")' },
        primary_only: { type: 'boolean', description: 'Return only primary implementing statutes (default: false)' },
        in_force_only: { type: 'boolean', description: 'Return only in-force statutes (default: false)' },
      },
      required: ['eu_document_id'],
    },
  },
  {
    name: 'search_eu_implementations',
    description: `Search for EU directives and regulations with Finnish implementation information.

When NOT to use: If you already know the EU document ID, use get_finnish_implementations for direct lookup.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search (title, short name, CELEX, description)' },
        type: { type: 'string', enum: ['directive', 'regulation'], description: 'Filter by document type' },
        year_from: { type: 'number', description: 'Filter by year (from)' },
        year_to: { type: 'number', description: 'Filter by year (to)' },
        community: { type: 'string', enum: ['EU', 'EG', 'EEG', 'Euratom'], description: 'Filter by community' },
        has_finnish_implementation: { type: 'boolean', description: 'Filter by Finnish implementation existence' },
        limit: { type: 'number', description: 'Maximum results', default: 20, minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_provision_eu_basis',
    description: `Get EU legal basis for a specific provision within a Finnish statute.

When NOT to use: For statute-level EU references (not a specific provision), use get_eu_basis instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        sfs_number: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
        provision_ref: { type: 'string', description: 'Provision reference (e.g., "1:1" or "3:5")' },
      },
      required: ['sfs_number', 'provision_ref'],
    },
  },
  {
    name: 'validate_eu_compliance',
    description: `Validate EU compliance status for a Finnish statute or provision.

When NOT to use: For basic EU reference lookup, use get_eu_basis. This tool assesses compliance status.`,
    inputSchema: {
      type: 'object',
      properties: {
        sfs_number: { type: 'string', description: 'statute number (e.g., "1050/2018" or "2018:218")' },
        provision_ref: { type: 'string', description: 'Optional provision reference (e.g., "1:1")' },
        eu_document_id: { type: 'string', description: 'Optional: check compliance with specific EU document' },
      },
      required: ['sfs_number'],
    },
  },
  {
    name: 'list_sources',
    description: `List all authoritative data sources used by this server, including provider, license, coverage, and freshness metadata. Call this to understand where the data comes from.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  provisionAtDateDef as Tool,
];

export function buildTools(context?: AboutContext): Tool[] {
  return context ? [...TOOLS, ABOUT_TOOL] : TOOLS;
}

export function registerTools(
  server: Server,
  db: InstanceType<typeof Database>,
  context?: AboutContext,
): void {
  const allTools = buildTools(context);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'search_legislation':
          result = await searchLegislation(db, args as unknown as SearchLegislationInput);
          break;
        case 'get_provision':
          result = await getProvision(db, args as unknown as GetProvisionInput);
          break;
        case 'search_case_law':
          result = await searchCaseLaw(db, args as unknown as SearchCaseLawInput);
          break;
        case 'get_preparatory_works':
          result = await getPreparatoryWorks(db, args as unknown as GetPreparatoryWorksInput);
          break;
        case 'validate_citation':
          result = await validateCitationTool(db, args as unknown as ValidateCitationInput);
          break;
        case 'build_legal_stance':
          result = await buildLegalStance(db, args as unknown as BuildLegalStanceInput);
          break;
        case 'format_citation':
          result = await formatCitationTool(args as unknown as FormatCitationInput);
          break;
        case 'check_currency':
          result = await checkCurrency(db, args as unknown as CheckCurrencyInput);
          break;
        case 'get_eu_basis':
          result = await getEUBasis(db, args as unknown as GetEUBasisInput);
          break;
        case 'get_finnish_implementations':
          result = await getFinnishImplementations(db, args as unknown as GetFinnishImplementationsInput);
          break;
        case 'get_swedish_implementations': // legacy alias for older clients
          result = await getFinnishImplementations(db, args as unknown as GetFinnishImplementationsInput);
          break;
        case 'search_eu_implementations':
          result = await searchEUImplementations(db, args as unknown as SearchEUImplementationsInput);
          break;
        case 'get_provision_eu_basis':
          result = await getProvisionEUBasis(db, args as unknown as GetProvisionEUBasisInput);
          break;
        case 'validate_eu_compliance':
          result = await validateEUCompliance(db, args as unknown as ValidateEUComplianceInput);
          break;
        case 'list_sources':
          result = listSources();
          break;
        case 'get_provision_at_date':
          result = getProvisionAtDate(db, args as unknown as GetProvisionAtDateParams);
          break;
        case 'about':
          if (context) {
            result = getAbout(db, context);
          } else {
            return {
              content: [{ type: 'text', text: 'About tool not configured.' }],
              isError: true,
            };
          }
          break;
        default:
          return {
            content: [{ type: 'text', text: `Error: Unknown tool "${name}".` }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${message}` }],
        isError: true,
      };
    }
  });
}
