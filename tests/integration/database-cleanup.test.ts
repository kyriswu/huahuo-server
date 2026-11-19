import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const databaseUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!databaseUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED: run scripts/integration.mjs');
}
const config = loadConfig('migrate', { DATABASE_URL: databaseUrl });
const pool = poolFor(config);

describe('database cleanup invariants', () => {
  beforeAll(() => migrate(config));
  afterAll(() => pool.end());

  it('does not retain redundant records or write-only security and scheduler fields', async () => {
    const tables = await pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
      [['upload_parts', 'resource_delete_requests', 'task_requests']],
    );
    expect(tables.rows).toEqual([]);
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
        AND ((table_name='admin_sessions' AND column_name='csrf_hash')
          OR (table_name='task_schedules' AND column_name IN ('lease_owner','lease_until')))`,
    );
    expect(columns.rows).toEqual([]);
  });

  it('has no redundant ordinary indexes with exactly the same indexing structure', async () => {
    const result = await pool.query<{ table_name: string; first_index: string; second_index: string }>(
      `SELECT t.relname AS table_name,a.relname AS first_index,b.relname AS second_index
         FROM pg_index x JOIN pg_index y ON x.indrelid=y.indrelid AND x.indexrelid<y.indexrelid
         JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
         JOIN pg_class a ON a.oid=x.indexrelid JOIN pg_class b ON b.oid=y.indexrelid
        WHERE n.nspname='public' AND (NOT x.indisunique OR NOT y.indisunique)
          AND x.indisvalid AND x.indisready AND x.indislive
          AND y.indisvalid AND y.indisready AND y.indislive
          AND a.relam=b.relam AND x.indnatts=y.indnatts AND x.indnkeyatts=y.indnkeyatts
          AND x.indkey=y.indkey AND x.indclass=y.indclass AND x.indcollation=y.indcollation
          AND x.indoption=y.indoption
          AND x.indexprs::text IS NOT DISTINCT FROM y.indexprs::text
          AND x.indpred::text IS NOT DISTINCT FROM y.indpred::text
        ORDER BY t.relname,a.relname,b.relname`,
    );
    expect(result.rows).toEqual([]);
  });

  it('retains unique event/chunk keys without a PostgreSQL RAG full-text index', async () => {
    const indexes = await pool.query<{ table_name: string; method: string; is_unique: boolean; column_names: string[] }>(
      `SELECT t.relname AS table_name,am.amname AS method,i.indisunique AS is_unique,
              array_agg(a.attname::text ORDER BY k.ordinal) AS column_names
         FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
         JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class idx ON idx.oid=i.indexrelid
         JOIN pg_am am ON am.oid=idx.relam
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinal)
         JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
        WHERE n.nspname='public' AND t.relname IN ('content_events','kb_content_asset_hybrid_chunks','content_assets')
          AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
          AND k.ordinal<=i.indnkeyatts
        GROUP BY i.indexrelid,t.relname,am.amname,i.indisunique`,
    );
    expect(indexes.rows).toEqual(expect.arrayContaining([
      { table_name: 'content_events', method: 'btree', is_unique: true, column_names: ['user_id', 'cursor'] },
      { table_name: 'kb_content_asset_hybrid_chunks', method: 'btree', is_unique: true, column_names: ['build_id', 'ordinal'] },
    ]));
    const state = await pool.query("SELECT to_regclass('public.account_content_state') IS NOT NULL AS present");
    expect(state.rows[0]).toEqual({ present: true });
  });

  it('stores TOC and its independent stage status for both business sources', async () => {
    const result = await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('rag_ingestion_versions','kb_content_asset_hybrid_builds')
          AND column_name IN ('toc','toc_status')`,
    );
    expect(result.rows).toHaveLength(4);
    for (const table of ['rag_ingestion_versions', 'kb_content_asset_hybrid_builds']) {
      expect(result.rows).toEqual(expect.arrayContaining([
        { table_name: table, column_name: 'toc', data_type: 'jsonb', is_nullable: 'YES' },
        { table_name: table, column_name: 'toc_status', data_type: 'text', is_nullable: 'NO' },
      ]));
    }
  });
});
