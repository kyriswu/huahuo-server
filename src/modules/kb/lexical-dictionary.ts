import type pg from 'pg';
import { digest } from '../../lib/crypto.js';

import type { LexicalDictionary } from '../../lib/search-index/types.js';

/** The dictionary keeps stable uint32 coordinates without persisting token text.
 * Zero is reserved for documents whose analyzer emits no searchable terms. */
export class PgLexicalDictionary implements LexicalDictionary {
  constructor(private readonly pool: pg.Pool) {}

  async coordinates(terms: readonly string[], allocate: boolean): Promise<ReadonlyMap<string, number>> {
    const keys = new Map([...new Set(terms)].map(term => [digest(term), term]));
    if (!keys.size) return new Map();
    const lookup = (requested: string[]) => this.pool.query<{ term_key: string; token_id: string }>(
      'SELECT term_key,token_id FROM public.kb_lexical_terms WHERE term_key=ANY($1::text[])', [requested],
    );
    const rows = (await lookup([...keys.keys()])).rows;
    if (allocate && rows.length < keys.size) {
      const found = new Set(rows.map(row => row.term_key));
      const missing = [...keys.keys()].filter(key => !found.has(key)).sort();
      await this.pool.query(`INSERT INTO public.kb_lexical_terms(term_key)
        SELECT term_key FROM unnest($1::text[]) AS requested(term_key) ORDER BY term_key
        ON CONFLICT(term_key) DO NOTHING`, [missing]);
      rows.push(...(await lookup(missing)).rows);
      if (rows.length !== keys.size) throw new Error('KB_LEXICAL_TERM_ALLOCATION_INCOMPLETE');
    }
    return new Map(rows.map(row => [keys.get(row.term_key)!, Number(row.token_id)]));
  }
}
