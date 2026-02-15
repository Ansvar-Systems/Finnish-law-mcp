/**
 * get_finnish_implementations — Alias for EU implementation lookup.
 *
 * The underlying query logic is country-neutral and table-driven.
 * We keep the Swedish-named exports for backwards compatibility.
 */

export {
  getSwedishImplementations as getFinnishImplementations,
  type GetSwedishImplementationsInput as GetFinnishImplementationsInput,
  type GetSwedishImplementationsResult as GetFinnishImplementationsResult,
} from './get-swedish-implementations.js';
