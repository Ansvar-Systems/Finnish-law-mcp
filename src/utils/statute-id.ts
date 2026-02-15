import type { Database } from '@ansvar/mcp-sqlite';

const SWEDISH_STATUTE_ID = /^\d{4}:\d+$/u;
const FINNISH_STATUTE_ID = /^\d+\/\d{4}$/u;

export function isValidStatuteId(id: string): boolean {
  return SWEDISH_STATUTE_ID.test(id) || FINNISH_STATUTE_ID.test(id);
}

export function statuteIdCandidates(id: string): string[] {
  const trimmed = id.trim();
  const candidates = new Set<string>();
  candidates.add(trimmed);

  if (SWEDISH_STATUTE_ID.test(trimmed)) {
    const [year, number] = trimmed.split(':');
    candidates.add(`${number}/${year}`);
  } else if (FINNISH_STATUTE_ID.test(trimmed)) {
    const [number, year] = trimmed.split('/');
    candidates.add(`${year}:${number}`);
  }

  return [...candidates];
}

export function resolveExistingStatuteId(
  db: Database,
  inputId: string,
): string | null {
  const candidates = statuteIdCandidates(inputId);
  const placeholders = candidates.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT id FROM legal_documents WHERE type = 'statute' AND id IN (${placeholders}) LIMIT 1`
  ).get(...candidates) as { id: string } | undefined;

  return row?.id ?? null;
}
