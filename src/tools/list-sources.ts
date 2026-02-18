/**
 * list_sources — Return authoritative data sources and their metadata.
 */

export interface ListSourcesResult {
  sources: DataSource[];
  data_currency: {
    last_ingested: string;
    check_frequency: string;
  };
}

export interface DataSource {
  name: string;
  authority: string;
  url: string;
  license: string;
  coverage: string;
  languages: string[];
  retrieval_method: string;
}

export function listSources(): ListSourcesResult {
  return {
    sources: [
      {
        name: 'Finlex',
        authority: 'Finnish Ministry of Justice',
        url: 'https://finlex.fi',
        license: 'Government Open Data (CC BY 4.0)',
        coverage: 'Finnish statutes and regulations',
        languages: ['fi', 'sv'],
        retrieval_method: 'Akoma Ntoso XML via opendata.finlex.fi',
      },
      {
        name: 'EUR-Lex',
        authority: 'Publications Office of the European Union',
        url: 'https://eur-lex.europa.eu',
        license: 'EU public domain',
        coverage: 'EU directives and regulations referenced by Finnish statutes',
        languages: ['en', 'fi'],
        retrieval_method: 'EUR-Lex CELLAR API',
      },
    ],
    data_currency: {
      last_ingested: '2026-02-14',
      check_frequency: 'daily',
    },
  };
}
