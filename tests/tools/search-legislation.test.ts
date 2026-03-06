import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@ansvar/mcp-sqlite';
import { searchLegislation } from '../../src/tools/search-legislation.js';
import { createTestDatabase, closeTestDatabase } from '../fixtures/test-db.js';

describe('search_legislation', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(() => {
    closeTestDatabase(db);
  });

  it('should find provisions by keyword', async () => {
    const response = await searchLegislation(db, { query: 'henkilötietojen' });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]).toHaveProperty('document_id');
    expect(response.results[0]).toHaveProperty('provision_ref');
    expect(response.results[0]).toHaveProperty('snippet');
    expect(response._metadata).toHaveProperty('disclaimer');
    expect(response._metadata).toHaveProperty('data_freshness');
  });

  it('should filter by document_id', async () => {
    const response = await searchLegislation(db, {
      query: 'henkilötietojen',
      document_id: '1050/2018',
    });
    expect(response.results.length).toBeGreaterThan(0);
    for (const r of response.results) {
      expect(r.document_id).toBe('1050/2018');
    }
  });

  it('should filter by status', async () => {
    const response = await searchLegislation(db, {
      query: 'henkilötietoja',
      status: 'repealed',
    });
    // Henkilötietolaki (523/1999) is repealed and mentions henkilötietoja
    for (const r of response.results) {
      expect(r.document_id).toBe('523/1999');
    }
  });

  it('should respect limit', async () => {
    const response = await searchLegislation(db, {
      query: 'henkilötietojen',
      limit: 2,
    });
    expect(response.results.length).toBeLessThanOrEqual(2);
  });

  it('should return empty array for empty query', async () => {
    const response = await searchLegislation(db, { query: '' });
    expect(response.results).toEqual([]);
  });

  it('should cap limit at MAX_LIMIT', async () => {
    const response = await searchLegislation(db, {
      query: 'henkilötietojen',
      limit: 100, // exceeds MAX_LIMIT of 50
    });
    expect(response.results.length).toBeLessThanOrEqual(50);
  });

  it('should return historical provision versions for as_of_date', async () => {
    const response = await searchLegislation(db, {
      query: 'Tietosuojavaltuutettu',
      as_of_date: '2019-06-01',
      document_id: '1050/2018',
    });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].provision_ref).toBe('3:1');
  });

  it('should reject invalid as_of_date', async () => {
    await expect(
      searchLegislation(db, {
        query: 'henkilötietojen',
        as_of_date: '2019/06/01',
      })
    ).rejects.toThrow('as_of_date must be an ISO date');
  });
});
