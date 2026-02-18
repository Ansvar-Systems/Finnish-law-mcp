import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@ansvar/mcp-sqlite';
import { buildLegalStance } from '../../src/tools/build-legal-stance.js';
import { createTestDatabase, closeTestDatabase } from '../fixtures/test-db.js';

describe('build_legal_stance', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(() => {
    closeTestDatabase(db);
  });

  it('should aggregate citations from multiple sources', async () => {
    const response = await buildLegalStance(db, { query: 'henkilötietojen' });

    expect(response.results.query).toBe('henkilötietojen');
    expect(response.results.provisions.length).toBeGreaterThan(0);
    expect(response.results.case_law.length).toBeGreaterThan(0);
    expect(response.results.total_citations).toBeGreaterThan(0);
    expect(response.results.total_citations).toBe(
      response.results.provisions.length + response.results.case_law.length + response.results.preparatory_works.length
    );
  });

  it('should filter provisions by document_id', async () => {
    const response = await buildLegalStance(db, {
      query: 'henkilötietojen',
      document_id: '1050/2018',
    });

    for (const prov of response.results.provisions) {
      expect(prov.document_id).toBe('1050/2018');
    }
  });

  it('should exclude case law when requested', async () => {
    const response = await buildLegalStance(db, {
      query: 'henkilötietojen',
      include_case_law: false,
    });

    expect(response.results.case_law).toEqual([]);
  });

  it('should exclude preparatory works when requested', async () => {
    const response = await buildLegalStance(db, {
      query: 'henkilötietojen',
      include_preparatory_works: false,
    });

    expect(response.results.preparatory_works).toEqual([]);
  });

  it('should respect limit', async () => {
    const response = await buildLegalStance(db, {
      query: 'henkilötietojen',
      limit: 1,
    });

    expect(response.results.provisions.length).toBeLessThanOrEqual(1);
    expect(response.results.case_law.length).toBeLessThanOrEqual(1);
  });

  it('should return empty results for empty query', async () => {
    const response = await buildLegalStance(db, { query: '' });

    expect(response.results.provisions).toEqual([]);
    expect(response.results.case_law).toEqual([]);
    expect(response.results.preparatory_works).toEqual([]);
    expect(response.results.total_citations).toBe(0);
  });

  it('should apply as_of_date to historical retrieval', async () => {
    const response = await buildLegalStance(db, {
      query: 'Tietosuojavaltuutettu',
      document_id: '1050/2018',
      as_of_date: '2019-06-01',
      include_case_law: false,
      include_preparatory_works: false,
    });

    expect(response.results.as_of_date).toBe('2019-06-01');
    expect(response.results.provisions.length).toBeGreaterThan(0);
    expect(response.results.provisions[0].provision_ref).toBe('3:1');
  });
});
