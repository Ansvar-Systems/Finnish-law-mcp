/**
 * Test database fixture with Finnish law sample data.
 */

import Database from '@ansvar/mcp-sqlite';

const SCHEMA = `
CREATE TABLE legal_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('statute', 'bill', 'sou', 'ds', 'case_law')),
  title TEXT NOT NULL,
  title_en TEXT,
  short_name TEXT,
  status TEXT NOT NULL DEFAULT 'in_force'
    CHECK(status IN ('in_force', 'amended', 'repealed', 'not_yet_in_force')),
  issued_date TEXT,
  in_force_date TEXT,
  url TEXT,
  description TEXT,
  last_updated TEXT DEFAULT (datetime('now'))
);

CREATE TABLE legal_provisions (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  provision_ref TEXT NOT NULL,
  chapter TEXT,
  section TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(document_id, provision_ref)
);

CREATE INDEX idx_provisions_doc ON legal_provisions(document_id);
CREATE INDEX idx_provisions_chapter ON legal_provisions(document_id, chapter);

CREATE VIRTUAL TABLE provisions_fts USING fts5(
  content, title,
  content='legal_provisions',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER provisions_ai AFTER INSERT ON legal_provisions BEGIN
  INSERT INTO provisions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

CREATE TRIGGER provisions_ad AFTER DELETE ON legal_provisions BEGIN
  INSERT INTO provisions_fts(provisions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
END;

CREATE TRIGGER provisions_au AFTER UPDATE ON legal_provisions BEGIN
  INSERT INTO provisions_fts(provisions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
  INSERT INTO provisions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

CREATE TABLE legal_provision_versions (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  provision_ref TEXT NOT NULL,
  chapter TEXT,
  section TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  metadata TEXT,
  valid_from TEXT,
  valid_to TEXT
);

CREATE INDEX idx_provision_versions_doc_ref ON legal_provision_versions(document_id, provision_ref);

CREATE VIRTUAL TABLE provision_versions_fts USING fts5(
  content, title,
  content='legal_provision_versions',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER provision_versions_ai AFTER INSERT ON legal_provision_versions BEGIN
  INSERT INTO provision_versions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

CREATE TRIGGER provision_versions_ad AFTER DELETE ON legal_provision_versions BEGIN
  INSERT INTO provision_versions_fts(provision_versions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
END;

CREATE TRIGGER provision_versions_au AFTER UPDATE ON legal_provision_versions BEGIN
  INSERT INTO provision_versions_fts(provision_versions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
  INSERT INTO provision_versions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

CREATE TABLE case_law (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES legal_documents(id),
  court TEXT NOT NULL,
  case_number TEXT,
  decision_date TEXT,
  summary TEXT,
  keywords TEXT
);

CREATE VIRTUAL TABLE case_law_fts USING fts5(
  summary, keywords,
  content='case_law',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER case_law_ai AFTER INSERT ON case_law BEGIN
  INSERT INTO case_law_fts(rowid, summary, keywords)
  VALUES (new.id, new.summary, new.keywords);
END;

CREATE TRIGGER case_law_ad AFTER DELETE ON case_law BEGIN
  INSERT INTO case_law_fts(case_law_fts, rowid, summary, keywords)
  VALUES ('delete', old.id, old.summary, old.keywords);
END;

CREATE TABLE preparatory_works (
  id INTEGER PRIMARY KEY,
  statute_id TEXT NOT NULL REFERENCES legal_documents(id),
  prep_document_id TEXT NOT NULL REFERENCES legal_documents(id),
  title TEXT,
  summary TEXT
);

CREATE INDEX idx_prep_statute ON preparatory_works(statute_id);

CREATE VIRTUAL TABLE prep_works_fts USING fts5(
  title, summary,
  content='preparatory_works',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER prep_works_ai AFTER INSERT ON preparatory_works BEGIN
  INSERT INTO prep_works_fts(rowid, title, summary)
  VALUES (new.id, new.title, new.summary);
END;

CREATE TRIGGER prep_works_ad AFTER DELETE ON preparatory_works BEGIN
  INSERT INTO prep_works_fts(prep_works_fts, rowid, title, summary)
  VALUES ('delete', old.id, old.title, old.summary);
END;

CREATE TABLE cross_references (
  id INTEGER PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES legal_documents(id),
  source_provision_ref TEXT,
  target_document_id TEXT NOT NULL REFERENCES legal_documents(id),
  target_provision_ref TEXT,
  ref_type TEXT NOT NULL DEFAULT 'references'
    CHECK(ref_type IN ('references', 'amended_by', 'implements', 'see_also'))
);

CREATE INDEX idx_xref_source ON cross_references(source_document_id);
CREATE INDEX idx_xref_target ON cross_references(target_document_id);

CREATE TABLE definitions (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  term TEXT NOT NULL,
  term_en TEXT,
  definition TEXT NOT NULL,
  source_provision TEXT,
  UNIQUE(document_id, term)
);

CREATE VIRTUAL TABLE definitions_fts USING fts5(
  term, definition,
  content='definitions',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER definitions_ai AFTER INSERT ON definitions BEGIN
  INSERT INTO definitions_fts(rowid, term, definition)
  VALUES (new.id, new.term, new.definition);
END;

CREATE TRIGGER definitions_ad AFTER DELETE ON definitions BEGIN
  INSERT INTO definitions_fts(definitions_fts, rowid, term, definition)
  VALUES ('delete', old.id, old.term, old.definition);
END;

CREATE TABLE IF NOT EXISTS eu_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('directive', 'regulation')),
  year INTEGER NOT NULL,
  number INTEGER NOT NULL,
  community TEXT CHECK(community IN ('EU', 'EG', 'EEG', 'Euratom')),
  celex_number TEXT,
  title TEXT,
  title_sv TEXT,
  short_name TEXT,
  adoption_date TEXT,
  entry_into_force_date TEXT,
  in_force BOOLEAN DEFAULT 1,
  amended_by TEXT,
  repeals TEXT,
  url_eur_lex TEXT,
  description TEXT,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS eu_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK(source_type IN ('provision', 'document', 'case_law')),
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  provision_id INTEGER REFERENCES legal_provisions(id),
  eu_document_id TEXT NOT NULL REFERENCES eu_documents(id),
  eu_article TEXT,
  reference_type TEXT NOT NULL CHECK(reference_type IN (
    'implements', 'supplements', 'applies', 'references', 'complies_with',
    'derogates_from', 'amended_by', 'repealed_by', 'cites_article'
  )),
  reference_context TEXT,
  full_citation TEXT,
  is_primary_implementation BOOLEAN DEFAULT 0,
  implementation_status TEXT CHECK(implementation_status IN ('complete', 'partial', 'pending', 'unknown')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_verified TEXT,
  UNIQUE(source_id, eu_document_id, eu_article)
);

CREATE INDEX IF NOT EXISTS idx_eu_references_document ON eu_references(document_id, eu_document_id);
CREATE INDEX IF NOT EXISTS idx_eu_references_eu_document ON eu_references(eu_document_id, document_id);
CREATE INDEX IF NOT EXISTS idx_eu_references_provision ON eu_references(provision_id, eu_document_id);
`;

const SAMPLE_DOCUMENTS = [
  { id: '1050/2018', type: 'statute', title: 'Tietosuojalaki', title_en: 'Data Protection Act', short_name: 'TietosuojaL', status: 'in_force', issued_date: '2018-12-05', in_force_date: '2019-01-01', url: 'https://www.finlex.fi/fi/laki/ajantasa/2018/20181050', description: 'Laki luonnollisten henkilöiden suojelusta henkilötietojen käsittelyssä' },
  { id: '523/1999', type: 'statute', title: 'Henkilötietolaki', title_en: 'Personal Data Act', short_name: 'HenkilötietoL', status: 'repealed', issued_date: '1999-04-22', in_force_date: '1999-06-01', url: null, description: 'Kumottu 2019-01-01 lailla 1050/2018' },
  { id: 'HE 9/2018 vp', type: 'bill', title: 'Hallituksen esitys tietosuojalaiksi', title_en: 'Government proposal for Data Protection Act', short_name: null, status: 'in_force', issued_date: '2018-03-01', in_force_date: null, url: null, description: 'Hallituksen esitys EU:n yleistä tietosuoja-asetusta täydentäväksi lainsäädännöksi' },
  { id: 'LaVM 13/2018 vp', type: 'sou', title: 'Lakivaliokunnan mietintö tietosuojalaiksi', title_en: null, short_name: null, status: 'in_force', issued_date: '2018-10-12', in_force_date: null, url: null, description: 'Lakivaliokunnan mietintö hallituksen esityksestä tietosuojalaiksi' },
  { id: 'KKO:2020:45', type: 'case_law', title: 'KKO:2020:45', title_en: null, short_name: null, status: 'in_force', issued_date: '2020-03-15', in_force_date: null, url: null, description: 'Ratkaisu henkilötietojen käsittelystä' },
  { id: 'KHO:2019:100', type: 'case_law', title: 'KHO:2019:100', title_en: null, short_name: null, status: 'in_force', issued_date: '2019-06-20', in_force_date: null, url: null, description: 'Ratkaisu tietosuojavaltuutetun päätöksestä' },
];

const SAMPLE_PROVISIONS = [
  { document_id: '1050/2018', provision_ref: '1:1', chapter: '1', section: '1', title: 'Lain tarkoitus', content: 'Tällä lailla täydennetään Euroopan parlamentin ja neuvoston asetusta (EU) 2016/679 luonnollisten henkilöiden suojelusta henkilötietojen käsittelyssä sekä näiden tietojen vapaasta liikkuvuudesta ja direktiivin 95/46/EY kumoamisesta (yleinen tietosuoja-asetus).' },
  { document_id: '1050/2018', provision_ref: '1:2', chapter: '1', section: '2', title: 'Lain soveltamisala', content: 'Tätä lakia sovelletaan henkilötietojen käsittelyyn, joka on kokonaan tai osittain automaattista, sekä muuhun henkilötietojen käsittelyyn silloin, kun henkilötiedot muodostavat rekisterin osan.' },
  { document_id: '1050/2018', provision_ref: '1:3', chapter: '1', section: '3', title: null, content: 'Lakia ei sovelleta henkilötietojen käsittelyyn, jonka luonnollinen henkilö suorittaa yksinomaan henkilökohtaisessa tai niihin verrattavissa kotitalouttaan koskevassa toiminnassa.' },
  { document_id: '1050/2018', provision_ref: '2:1', chapter: '2', section: '1', title: 'Oikeusperuste henkilötietojen käsittelylle', content: 'Henkilötietoja saa käsitellä yleisen tietosuoja-asetuksen 6 artiklan 1 kohdan e alakohdan nojalla, jos käsittely on tarpeen yleistä etua koskevan tehtävän suorittamiseksi.' },
  { document_id: '1050/2018', provision_ref: '2:2', chapter: '2', section: '2', title: 'Tärkeää yleistä etua koskeva käsittely', content: 'Yleisen tietosuoja-asetuksen 9 artiklan 1 kohdassa tarkoitettuja erityisiä henkilötietoryhmiä saa käsitellä viranomaisen toimesta 9 artiklan 2 kohdan g alakohdan nojalla, kun käsittely on tarpeen tärkeän yleisen edun vuoksi.' },
  { document_id: '1050/2018', provision_ref: '3:1', chapter: '3', section: '1', title: 'Valvontaviranomainen', content: 'Tietosuojavaltuutetun toimisto on yleisessä tietosuoja-asetuksessa tarkoitettu valvontaviranomainen.' },
  { document_id: '1050/2018', provision_ref: '3:2', chapter: '3', section: '2', title: 'Hallinnolliset seuraamusmaksut', content: 'Tietosuojavaltuutetun toimisto voi määrätä hallinnollisen seuraamusmaksun yleisen tietosuoja-asetuksen 83 ja 84 artiklan nojalla.' },
  { document_id: '1050/2018', provision_ref: '4:1', chapter: '4', section: '1', title: 'Vahingonkorvaus', content: 'Rekisterinpitäjän tai henkilötietojen käsittelijän on korvattava rekisteröidylle vahinko ja henkilökohtaisen koskemattomuuden loukkaus, joka on aiheutunut tämän lain vastaisesta henkilötietojen käsittelystä.' },
  { document_id: '523/1999', provision_ref: '1', chapter: null, section: '1', title: 'Lain tarkoitus', content: 'Tämän lain tarkoituksena on toteuttaa yksityiselämän suojaa ja muita yksityisyyden suojaa turvaavia perusoikeuksia henkilötietoja käsiteltäessä.' },
  { document_id: '523/1999', provision_ref: '3', chapter: null, section: '3', title: 'Määritelmät', content: 'Tässä laissa tarkoitetaan: henkilötiedolla kaikenlaisia luonnollista henkilöä taikka hänen ominaisuuksiaan tai elinolosuhteitaan kuvaavia merkintöjä.' },
  { document_id: '523/1999', provision_ref: '5 a', chapter: null, section: '5 a', title: 'Väärinkäyttösäännös', content: 'Henkilötietojen käsittely, joka ei sisälly tai ole tarkoitettu sisällytettäväksi henkilötietojen jäsennettyyn kokoelmaan, on sallittua, jos käsittely ei loukkaa rekisteröidyn yksityisyyden suojaa.' },
];

const SAMPLE_PROVISION_VERSIONS = [
  { document_id: '1050/2018', provision_ref: '1:1', chapter: '1', section: '1', title: 'Lain tarkoitus', content: 'Tällä lailla täydennetään Euroopan parlamentin ja neuvoston asetusta (EU) 2016/679 luonnollisten henkilöiden suojelusta henkilötietojen käsittelyssä sekä näiden tietojen vapaasta liikkuvuudesta ja direktiivin 95/46/EY kumoamisesta (yleinen tietosuoja-asetus).', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '1:2', chapter: '1', section: '2', title: 'Lain soveltamisala', content: 'Tätä lakia sovelletaan henkilötietojen käsittelyyn, joka on kokonaan tai osittain automaattista, sekä muuhun henkilötietojen käsittelyyn silloin, kun henkilötiedot muodostavat rekisterin osan.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '1:3', chapter: '1', section: '3', title: null, content: 'Lakia ei sovelleta henkilötietojen käsittelyyn, jonka luonnollinen henkilö suorittaa yksinomaan henkilökohtaisessa tai niihin verrattavissa kotitalouttaan koskevassa toiminnassa.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '2:1', chapter: '2', section: '1', title: 'Oikeusperuste henkilötietojen käsittelylle', content: 'Henkilötietoja saa käsitellä yleisen tietosuoja-asetuksen 6 artiklan 1 kohdan e alakohdan nojalla, jos käsittely on tarpeen yleistä etua koskevan tehtävän suorittamiseksi.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '2:2', chapter: '2', section: '2', title: 'Tärkeää yleistä etua koskeva käsittely', content: 'Yleisen tietosuoja-asetuksen 9 artiklan 1 kohdassa tarkoitettuja erityisiä henkilötietoryhmiä saa käsitellä viranomaisen toimesta 9 artiklan 2 kohdan g alakohdan nojalla, kun käsittely on tarpeen tärkeän yleisen edun vuoksi.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '3:1', chapter: '3', section: '1', title: 'Valvontaviranomainen', content: 'Tietosuojavaltuutettu on yleisessä tietosuoja-asetuksessa tarkoitettu valvontaviranomainen.', valid_from: '2018-05-25', valid_to: '2021-01-01' },
  { document_id: '1050/2018', provision_ref: '3:1', chapter: '3', section: '1', title: 'Valvontaviranomainen', content: 'Tietosuojavaltuutetun toimisto on yleisessä tietosuoja-asetuksessa tarkoitettu valvontaviranomainen.', valid_from: '2021-01-01', valid_to: null },
  { document_id: '1050/2018', provision_ref: '3:2', chapter: '3', section: '2', title: 'Hallinnolliset seuraamusmaksut', content: 'Tietosuojavaltuutetun toimisto voi määrätä hallinnollisen seuraamusmaksun yleisen tietosuoja-asetuksen 83 ja 84 artiklan nojalla.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '1050/2018', provision_ref: '4:1', chapter: '4', section: '1', title: 'Vahingonkorvaus', content: 'Rekisterinpitäjän tai henkilötietojen käsittelijän on korvattava rekisteröidylle vahinko ja henkilökohtaisen koskemattomuuden loukkaus, joka on aiheutunut tämän lain vastaisesta henkilötietojen käsittelystä.', valid_from: '2018-05-25', valid_to: null },
  { document_id: '523/1999', provision_ref: '1', chapter: null, section: '1', title: 'Lain tarkoitus', content: 'Tämän lain tarkoituksena on toteuttaa yksityiselämän suojaa ja muita yksityisyyden suojaa turvaavia perusoikeuksia henkilötietoja käsiteltäessä.', valid_from: '1998-10-24', valid_to: '2018-05-25' },
  { document_id: '523/1999', provision_ref: '3', chapter: null, section: '3', title: 'Määritelmät', content: 'Tässä laissa tarkoitetaan: henkilötiedolla kaikenlaisia luonnollista henkilöä taikka hänen ominaisuuksiaan tai elinolosuhteitaan kuvaavia merkintöjä.', valid_from: '1998-10-24', valid_to: '2018-05-25' },
  { document_id: '523/1999', provision_ref: '5 a', chapter: null, section: '5 a', title: 'Väärinkäyttösäännös', content: 'Henkilötietojen käsittely, joka ei sisälly tai ole tarkoitettu sisällytettäväksi henkilötietojen jäsennettyyn kokoelmaan, on sallittua, jos käsittely ei loukkaa rekisteröidyn yksityisyyden suojaa.', valid_from: '1998-10-24', valid_to: '2018-05-25' },
];

const SAMPLE_CASE_LAW = [
  { document_id: 'KKO:2020:45', court: 'KKO', case_number: 'S2019/123', decision_date: '2020-03-15', summary: 'Korkein oikeus tutki vahingonkorvausvaatimuksen lainvastaisesta henkilötietojen käsittelystä. Tuomioistuin katsoi, että rekisteröidyllä oli oikeus korvaukseen käsittelyn aiheuttamasta henkilökohtaisen koskemattomuuden loukkauksesta.', keywords: 'henkilötiedot vahingonkorvaus tietosuoja GDPR' },
  { document_id: 'KHO:2019:100', court: 'KHO', case_number: '1234/2/18', decision_date: '2019-06-20', summary: 'Korkein hallinto-oikeus vahvisti tietosuojavaltuutetun päätöksen hallinnollisesta seuraamusmaksusta puutteellisesta erityisten henkilötietoryhmien käsittelystä terveydenhuollossa.', keywords: 'valvonta seuraamusmaksu erityiset henkilötietoryhmät terveydenhuolto' },
];

const SAMPLE_PREPARATORY_WORKS = [
  { statute_id: '1050/2018', prep_document_id: 'HE 9/2018 vp', title: 'Hallituksen esitys tietosuojalaiksi', summary: 'Hallituksen esityksessä ehdotetaan säädettäväksi tietosuojalaki, jolla täydennetään EU:n yleistä tietosuoja-asetusta. Laki korvaa henkilötietolain (523/1999).' },
  { statute_id: '1050/2018', prep_document_id: 'LaVM 13/2018 vp', title: 'Lakivaliokunnan mietintö tietosuojalaiksi', summary: 'Lakivaliokunnan mietinnössä ehdotetaan täydentäviä säännöksiä EU:n yleiseen tietosuoja-asetukseen Suomen oikeusjärjestelmän mukauttamiseksi.' },
];

const SAMPLE_DEFINITIONS = [
  { document_id: '1050/2018', term: 'henkilötieto', term_en: 'personal data', definition: 'Kaikki tunnistettuun tai tunnistettavissa olevaan luonnolliseen henkilöön liittyvät tiedot.', source_provision: '1:1' },
  { document_id: '1050/2018', term: 'käsittely', term_en: 'processing', definition: 'Toiminto tai toimintojen kokonaisuus, joka kohdistuu henkilötietoihin.', source_provision: '1:1' },
  { document_id: '1050/2018', term: 'rekisterinpitäjä', term_en: 'controller', definition: 'Luonnollinen henkilö tai oikeushenkilö, joka määrittelee henkilötietojen käsittelyn tarkoitukset ja keinot.', source_provision: '1:1' },
  { document_id: '1050/2018', term: 'valvontaviranomainen', term_en: 'supervisory authority', definition: 'Tietosuojavaltuutetun toimisto on valvontaviranomainen.', source_provision: '3:1' },
  { document_id: '523/1999', term: 'henkilötieto', term_en: 'personal data', definition: 'Kaikenlaisia luonnollista henkilöä taikka hänen ominaisuuksiaan tai elinolosuhteitaan kuvaavia merkintöjä.', source_provision: '3' },
];

const SAMPLE_CROSS_REFS = [
  { source_document_id: '1050/2018', source_provision_ref: '1:1', target_document_id: '523/1999', target_provision_ref: null, ref_type: 'amended_by' },
  { source_document_id: '1050/2018', source_provision_ref: '3:2', target_document_id: '1050/2018', target_provision_ref: '3:1', ref_type: 'references' },
  { source_document_id: 'KKO:2020:45', source_provision_ref: null, target_document_id: '1050/2018', target_provision_ref: '4:1', ref_type: 'references' },
];

const SAMPLE_EU_DOCUMENTS = [
  {
    id: 'regulation:2016/679',
    type: 'regulation',
    year: 2016,
    number: 679,
    community: 'EU',
    celex_number: '32016R0679',
    title: 'Regulation (EU) 2016/679 on the protection of natural persons with regard to the processing of personal data',
    title_sv: 'Euroopan parlamentin ja neuvoston asetus (EU) 2016/679 luonnollisten henkilöiden suojelusta henkilötietojen käsittelyssä',
    short_name: 'GDPR',
    adoption_date: '2016-04-27',
    entry_into_force_date: '2018-05-25',
    in_force: 1,
    url_eur_lex: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
    description: 'General Data Protection Regulation',
  },
  {
    id: 'directive:95/46',
    type: 'directive',
    year: 1995,
    number: 46,
    community: 'EG',
    celex_number: '31995L0046',
    title: 'Directive 95/46/EC on the protection of individuals with regard to the processing of personal data',
    title_sv: 'Direktiivi 95/46/EY yksilöiden suojelusta henkilötietojen käsittelyssä',
    short_name: 'Data Protection Directive',
    adoption_date: '1995-10-24',
    entry_into_force_date: '1995-10-24',
    in_force: 0, // Repealed by GDPR
    amended_by: '["regulation:2016/679"]',
    url_eur_lex: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31995L0046',
    description: 'Repealed by GDPR on 2018-05-25',
  },
];

const SAMPLE_EU_REFERENCES = [
  // Tietosuojalaki (1050/2018) supplements GDPR
  {
    source_type: 'document',
    source_id: '1050/2018',
    document_id: '1050/2018',
    provision_id: null,
    eu_document_id: 'regulation:2016/679',
    eu_article: null,
    reference_type: 'supplements',
    full_citation: 'GDPR (EU) 2016/679',
    is_primary_implementation: 1,
    implementation_status: 'complete',
  },
  // Tietosuojalaki 2:1 references GDPR Article 6.1.e
  {
    source_type: 'provision',
    source_id: '1050/2018:2:1',
    document_id: '1050/2018',
    provision_id: 4, // provision_ref 2:1
    eu_document_id: 'regulation:2016/679',
    eu_article: '6.1.e',
    reference_type: 'cites_article',
    full_citation: 'GDPR Article 6.1.e',
    is_primary_implementation: 0,
  },
  // Tietosuojalaki 2:2 references GDPR Article 9.2.g
  {
    source_type: 'provision',
    source_id: '1050/2018:2:2',
    document_id: '1050/2018',
    provision_id: 5, // provision_ref 2:2
    eu_document_id: 'regulation:2016/679',
    eu_article: '9.2.g',
    reference_type: 'cites_article',
    full_citation: 'GDPR Article 9.2.g',
    is_primary_implementation: 0,
  },
  // Tietosuojalaki 3:2 references GDPR Articles 83-84
  {
    source_type: 'provision',
    source_id: '1050/2018:3:2',
    document_id: '1050/2018',
    provision_id: 7, // provision_ref 3:2
    eu_document_id: 'regulation:2016/679',
    eu_article: '83,84',
    reference_type: 'cites_article',
    full_citation: 'GDPR Articles 83 and 84',
    is_primary_implementation: 0,
  },
  // Henkilötietolaki (523/1999) implemented old Data Protection Directive (now repealed)
  {
    source_type: 'document',
    source_id: '523/1999',
    document_id: '523/1999',
    provision_id: null,
    eu_document_id: 'directive:95/46',
    eu_article: null,
    reference_type: 'implements',
    full_citation: 'Directive 95/46/EC',
    is_primary_implementation: 1,
    implementation_status: 'complete',
  },
];

export function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  insertSampleData(db);
  return db;
}

export function closeTestDatabase(db: Database.Database): void {
  if (db) db.close();
}

function insertSampleData(db: Database.Database): void {
  const insertDoc = db.prepare(`INSERT INTO legal_documents (id, type, title, title_en, short_name, status, issued_date, in_force_date, url, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const doc of SAMPLE_DOCUMENTS) {
    insertDoc.run(doc.id, doc.type, doc.title, doc.title_en, doc.short_name, doc.status, doc.issued_date, doc.in_force_date, doc.url, doc.description);
  }

  const insertProv = db.prepare(`INSERT INTO legal_provisions (document_id, provision_ref, chapter, section, title, content) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const prov of SAMPLE_PROVISIONS) {
    insertProv.run(prov.document_id, prov.provision_ref, prov.chapter, prov.section, prov.title, prov.content);
  }

  const insertProvVersion = db.prepare(`
    INSERT INTO legal_provision_versions (
      document_id, provision_ref, chapter, section, title, content, valid_from, valid_to
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const version of SAMPLE_PROVISION_VERSIONS) {
    insertProvVersion.run(
      version.document_id,
      version.provision_ref,
      version.chapter,
      version.section,
      version.title,
      version.content,
      version.valid_from,
      version.valid_to
    );
  }

  const insertCL = db.prepare(`INSERT INTO case_law (document_id, court, case_number, decision_date, summary, keywords) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const cl of SAMPLE_CASE_LAW) {
    insertCL.run(cl.document_id, cl.court, cl.case_number, cl.decision_date, cl.summary, cl.keywords);
  }

  const insertPW = db.prepare(`INSERT INTO preparatory_works (statute_id, prep_document_id, title, summary) VALUES (?, ?, ?, ?)`);
  for (const pw of SAMPLE_PREPARATORY_WORKS) {
    insertPW.run(pw.statute_id, pw.prep_document_id, pw.title, pw.summary);
  }

  const insertDef = db.prepare(`INSERT INTO definitions (document_id, term, term_en, definition, source_provision) VALUES (?, ?, ?, ?, ?)`);
  for (const def of SAMPLE_DEFINITIONS) {
    insertDef.run(def.document_id, def.term, def.term_en, def.definition, def.source_provision);
  }

  const insertXRef = db.prepare(`INSERT INTO cross_references (source_document_id, source_provision_ref, target_document_id, target_provision_ref, ref_type) VALUES (?, ?, ?, ?, ?)`);
  for (const xref of SAMPLE_CROSS_REFS) {
    insertXRef.run(xref.source_document_id, xref.source_provision_ref, xref.target_document_id, xref.target_provision_ref, xref.ref_type);
  }

  const insertEUDoc = db.prepare(`
    INSERT INTO eu_documents (
      id, type, year, number, community, celex_number, title, title_sv, short_name,
      adoption_date, entry_into_force_date, in_force, amended_by, url_eur_lex, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const euDoc of SAMPLE_EU_DOCUMENTS) {
    insertEUDoc.run(
      euDoc.id,
      euDoc.type,
      euDoc.year,
      euDoc.number,
      euDoc.community,
      euDoc.celex_number,
      euDoc.title,
      euDoc.title_sv,
      euDoc.short_name,
      euDoc.adoption_date,
      euDoc.entry_into_force_date,
      euDoc.in_force,
      euDoc.amended_by || null,
      euDoc.url_eur_lex,
      euDoc.description
    );
  }

  const insertEURef = db.prepare(`
    INSERT INTO eu_references (
      source_type, source_id, document_id, provision_id, eu_document_id, eu_article,
      reference_type, full_citation, is_primary_implementation, implementation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const euRef of SAMPLE_EU_REFERENCES) {
    insertEURef.run(
      euRef.source_type,
      euRef.source_id,
      euRef.document_id,
      euRef.provision_id,
      euRef.eu_document_id,
      euRef.eu_article,
      euRef.reference_type,
      euRef.full_citation,
      euRef.is_primary_implementation,
      euRef.implementation_status || null
    );
  }
}

export const sampleData = {
  documents: SAMPLE_DOCUMENTS,
  provisions: SAMPLE_PROVISIONS,
  provisionVersions: SAMPLE_PROVISION_VERSIONS,
  caseLaw: SAMPLE_CASE_LAW,
  preparatoryWorks: SAMPLE_PREPARATORY_WORKS,
  definitions: SAMPLE_DEFINITIONS,
  crossRefs: SAMPLE_CROSS_REFS,
  euDocuments: SAMPLE_EU_DOCUMENTS,
  euReferences: SAMPLE_EU_REFERENCES,
};
