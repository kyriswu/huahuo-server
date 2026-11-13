import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import * as models from '../../src/db/schema.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const databaseUrl = process.env.TEST_DATABASE_MIGRATION_URL;
if (!databaseUrl || !/^huahuo_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error('REAL_ISOLATED_TEST_DATABASE_REQUIRED: run scripts/integration.mjs');
}
const config = loadConfig('migrate', { DATABASE_URL: databaseUrl });
const pool = poolFor(config);

// These are plain logical relations. They must retain queryable keys without
// becoming PostgreSQL constraints or ORM foreign keys. Update this inventory
// whenever a business model adds/removes a logical reference.
const logicalReferences = [
  { tableName: 'kb_note_hybrid_builds', columnNames: ['source_id'] },
  { tableName: 'kb_note_hybrid_builds', columnNames: ['user_id'] },
  { tableName: 'kb_note_hybrid_builds', columnNames: ['workspace_id'] },
  { tableName: 'kb_note_hybrid_builds', columnNames: ['task_id'] },
  { tableName: 'kb_document_keyword_builds', columnNames: ['source_id'] },
  { tableName: 'kb_document_keyword_builds', columnNames: ['user_id'] },
  { tableName: 'kb_document_keyword_builds', columnNames: ['workspace_id'] },
  { tableName: 'kb_document_keyword_builds', columnNames: ['task_id'] },
  { tableName: 'kb_note_hybrid_chunks', columnNames: ['build_id'] },
  { tableName: 'kb_note_hybrid_chunks', columnNames: ['point_id'] },
  { tableName: 'kb_document_keyword_chunks', columnNames: ['build_id'] },
  { tableName: 'kb_document_keyword_chunks', columnNames: ['point_id'] },
  { tableName: 'text_ingestion_jobs', columnNames: ['created_by'] },
  { tableName: 'text_ingestion_jobs', columnNames: ['workspace_id'] },
  { tableName: 'text_ingestion_jobs', columnNames: ['current_task_id'] },
  { tableName: 'account_memberships', columnNames: ['policy_version'] },
  { tableName: 'account_memberships', columnNames: ['user_id'] },
  { tableName: 'admin_sessions', columnNames: ['admin_id'] },
  { tableName: 'user_agreement_acceptances', columnNames: ['session_id'] },
  { tableName: 'user_agreement_acceptances', columnNames: ['user_id'] },
  { tableName: 'users', columnNames: ['avatar_resource_id'] },
  { tableName: 'asset_folders', columnNames: ['parent_folder_id'] },
  { tableName: 'asset_folders', columnNames: ['workspace_id'] },
  { tableName: 'asset_tags', columnNames: ['workspace_id'] },
  { tableName: 'content_events', columnNames: ['workspace_id'] },
  { tableName: 'content_jobs', columnNames: ['note_id'] },
  { tableName: 'content_jobs', columnNames: ['task_id'] },
  { tableName: 'credit_ledger_entries', columnNames: ['lot_id'] },
  { tableName: 'credit_ledger_entries', columnNames: ['reservation_id'] },
  { tableName: 'credit_ledger_entries', columnNames: ['user_id'] },
  { tableName: 'credit_lots', columnNames: ['policy_version'] },
  { tableName: 'credit_lots', columnNames: ['user_id'] },
  { tableName: 'credit_reservation_lots', columnNames: ['lot_id'] },
  { tableName: 'credit_reservation_lots', columnNames: ['reservation_id'] },
  { tableName: 'credit_reservations', columnNames: ['policy_version'] },
  { tableName: 'credit_reservations', columnNames: ['task_id'] },
  { tableName: 'credit_reservations', columnNames: ['user_id'] },
  { tableName: 'note_part_revisions', columnNames: ['note_id'] },
  { tableName: 'note_relations', columnNames: ['source_note_id'] },
  { tableName: 'note_relations', columnNames: ['target_note_id'] },
  { tableName: 'note_relations', columnNames: ['workspace_id'] },
  { tableName: 'note_resource_refs', columnNames: ['note_id'] },
  { tableName: 'note_resource_refs', columnNames: ['resource_id'] },
  { tableName: 'note_tag_suggestions', columnNames: ['note_id'] },
  { tableName: 'note_tag_suggestions', columnNames: ['task_id'] },
  { tableName: 'note_tag_suggestions', columnNames: ['workspace_id'] },
  { tableName: 'note_tags', columnNames: ['note_id'] },
  { tableName: 'note_tags', columnNames: ['tag_id'] },
  { tableName: 'notes', columnNames: ['folder_id'] },
  { tableName: 'notes', columnNames: ['workspace_id'] },
  { tableName: 'onboarding_drafts', columnNames: ['workspace_id'] },
  { tableName: 'provider_usage_measurements', columnNames: ['reservation_id'] },
  { tableName: 'provider_usage_measurements', columnNames: ['user_id'] },
  { tableName: 'rag_document_assets', columnNames: ['version_id'] },
  { tableName: 'rag_ingestion_versions', columnNames: ['workspace_id', 'user_id'] },
  { tableName: 'refresh_tokens', columnNames: ['session_id'] },
  { tableName: 'resource_refs', columnNames: ['resource_id', 'user_id', 'workspace_id'] },
  { tableName: 'resources', columnNames: ['upload_id', 'user_id', 'workspace_id'] },
  { tableName: 'run_usage', columnNames: ['policy_version'] },
  { tableName: 'run_usage', columnNames: ['reservation_id'] },
  { tableName: 'run_usage', columnNames: ['task_id'] },
  { tableName: 'run_usage', columnNames: ['user_id'] },
  { tableName: 'storage_jobs', columnNames: ['resource_id'] },
  { tableName: 'storage_jobs', columnNames: ['task_id'] },
  { tableName: 'storage_jobs', columnNames: ['upload_id'] },
  { tableName: 'storage_reservations', columnNames: ['user_id'] },
  { tableName: 'task_attempts', columnNames: ['task_id'] },
  { tableName: 'task_events', columnNames: ['task_id'] },
  { tableName: 'task_inputs', columnNames: ['workspace_id', 'user_id'] },
  { tableName: 'task_outbox', columnNames: ['task_id'] },
  { tableName: 'task_results', columnNames: ['task_id'] },
  { tableName: 'task_schedule_windows', columnNames: ['schedule_id'] },
  { tableName: 'task_schedule_windows', columnNames: ['task_id'] },
  { tableName: 'tasks', columnNames: ['input_id'] },
  { tableName: 'tasks', columnNames: ['reservation_id'] },
  { tableName: 'tasks', columnNames: ['result_id'] },
  { tableName: 'tasks', columnNames: ['workspace_id', 'user_id'] },
  { tableName: 'upload_sessions', columnNames: ['reservation_id'] },
  { tableName: 'upload_sessions', columnNames: ['user_id'] },
  { tableName: 'upload_sessions', columnNames: ['workspace_id', 'user_id'] },
  { tableName: 'usage_periods', columnNames: ['user_id'] },
  { tableName: 'user_audit_events', columnNames: ['user_id'] },
  { tableName: 'user_identities', columnNames: ['user_id'] },
  { tableName: 'user_api_keys', columnNames: ['user_id'] },
  { tableName: 'user_sessions', columnNames: ['user_id'] },
  { tableName: 'workspace_content_state', columnNames: ['workspace_id'] },
  { tableName: 'workspace_profiles', columnNames: ['workspace_id'] },
  { tableName: 'workspaces', columnNames: ['user_id'] },
] satisfies Array<{ tableName: string; columnNames: string[] }>;

describe('database plain-key relationship policy', () => {
  beforeAll(() => migrate(config));
  afterAll(() => pool.end());

  it('has no physical foreign keys in application schemas', async () => {
    const result = await pool.query(
      `SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname AS constraint_name
         FROM pg_constraint c
         JOIN pg_class t ON t.oid=c.conrelid
         JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE c.contype='f' AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY n.nspname,t.relname,c.conname`,
    );
    expect(result.rows).toEqual([]);
  });

  it('does not declare foreign keys in Drizzle models', () => {
    const tables = Object.values(models).filter(value => is(value, PgTable));
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const definition = getTableConfig(table);
      expect(definition.foreignKeys, definition.name).toEqual([]);
    }
  });

  it('covers every logical relation with a valid non-partial Btree leading-key index', async () => {
    const result = await pool.query<{ table_name: string; column_names: string[] }>(
      `WITH expected AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(table_name text,column_names text[])
       )
       SELECT e.table_name,e.column_names
         FROM expected e
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_class t
          JOIN pg_namespace n ON n.oid=t.relnamespace
          JOIN pg_index i ON i.indrelid=t.oid
          JOIN pg_class idx ON idx.oid=i.indexrelid
          JOIN pg_am am ON am.oid=idx.relam
          WHERE n.nspname='public' AND t.relname=e.table_name
            AND am.amname='btree' AND i.indisvalid AND i.indisready AND i.indislive
            AND i.indpred IS NULL AND i.indexprs IS NULL
            AND i.indnkeyatts>=cardinality(e.column_names)
            AND (SELECT array_agg(a.attname::text ORDER BY k.ordinal)
                   FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinal)
                   JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
                  WHERE k.ordinal<=cardinality(e.column_names))=e.column_names
        ) ORDER BY e.table_name,e.column_names`,
      [JSON.stringify(logicalReferences.map(r => ({ table_name: r.tableName, column_names: r.columnNames })))],
    );
    expect(result.rows).toEqual([]);
  });
});
