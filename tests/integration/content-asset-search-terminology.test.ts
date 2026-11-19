import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { migrate } from '../../src/db/migrate.js';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { poolFor } from '../../src/plugins/dependencies.js';

const url = new URL(process.env.TEST_DATABASE_MIGRATION_URL ?? '');
if (url.hostname !== '127.0.0.1' || !/^\/huahuo_test_[a-z0-9_]+$/.test(url.pathname)) {
  throw new Error('ISOLATED_DATABASE_REQUIRED');
}
const config = loadConfig('migrate', { DATABASE_URL: url.href });
const pool = poolFor(config);
const migration = loadMigrationFiles().find(file => file.name === '0021_content_asset_search_terminology.sql')!;
const previousName = 'huahuo_kb_note_hybrid_chunks';
const nextName = 'huahuo_kb_content_asset_hybrid_chunks';
const hash = '5'.repeat(64);

beforeAll(() => migrate(config));
afterAll(() => pool.end());

async function insertBuild(tx: PoolClient, collection: string, database = 'default') {
  const [id, source, user, workspace, task] = Array.from({ length: 5 }, () => randomUUID());
  const snapshot = { mode: 'content-asset-hybrid', target: { connectionId: 'fixture', database, collection }, configHash: hash };
  await tx.query(`INSERT INTO public.kb_content_asset_hybrid_builds
    (id,source_type,source_id,source_revision,user_id,workspace_id,task_id,content_hash,config_hash,snapshot)
    VALUES($1,'content_asset',$2,'revision',$3,$4,$5,$6,$6,$7)`,
  [id, source, user, workspace, task, hash, JSON.stringify(snapshot)]);
  return { id, source, user, workspace, task, snapshot };
}

it('updates search snapshots and index attributes without replacing identities or custom targets', async () => {
  const tx = await pool.connect();
  await tx.query('BEGIN');
  try {
    const legacy = await insertBuild(tx, previousName);
    const custom = await insertBuild(tx, 'custom_content_assets');
    const [versionId, buildId, inputId, unrelatedInputId, textTaskId, unrelatedTaskId] = Array.from({ length: 6 }, () => randomUUID());
    const keyword = { mode: 'document-keyword', configHash: hash };
    const processing = { version: 'file-processing', format: 'markdown', keyword };
    const body = JSON.stringify({ jobId: randomUUID(), snapshot: processing });
    await tx.query(`INSERT INTO public.rag_ingestion_versions
      (id,user_id,workspace_id,idempotency_key,source_url,source_file_name,source_mime_type,mode,status,current_stage,document_key,processing_snapshot)
      VALUES($1,$2,$3,$1::uuid::text,'https://example.com/input.pdf','input.pdf','application/pdf','structured_document','RECEIVED','RECEIVED',$1::uuid::text,$4)`,
    [versionId, legacy.user, legacy.workspace, processing]);
    await tx.query(`INSERT INTO public.kb_document_keyword_builds
      (id,source_type,source_id,source_revision,user_id,workspace_id,task_id,content_hash,config_hash,snapshot)
      VALUES($1,'file',$2,'revision',$3,$4,$5,$6,$6,$7)`, [buildId, versionId, legacy.user, legacy.workspace, legacy.task, hash, keyword]);
    await tx.query('INSERT INTO public.task_inputs (id,user_id,workspace_id,body) VALUES($1,$2,$3,$4),($5,$2,$3,$4)',
      [inputId, legacy.user, legacy.workspace, body, unrelatedInputId]);
    await tx.query(`INSERT INTO public.tasks (id,user_id,workspace_id,kind,queue,input_id,state,trace_id)
      VALUES($1,$2,$3,'text.ingest','content',$4,'queued','search-terminology-fixture'),
        ($5,$2,$3,'content-asset.tag-extract','content',$6,'queued','search-terminology-fixture')`,
    [textTaskId, legacy.user, legacy.workspace, inputId, unrelatedTaskId, unrelatedInputId]);

    const indexIdentity = async () => (await tx.query(
      `SELECT i.indexrelid,n.attname FROM pg_index i JOIN pg_attribute n ON n.attrelid=i.indexrelid AND n.attnum=1
       WHERE i.indexrelid='public.content_assets_pkey'::regclass`)).rows[0];
    await tx.query('ALTER TABLE ONLY public.content_assets_pkey RENAME COLUMN content_asset_id TO note_id');
    const previous = await indexIdentity();
    await tx.query(migration.sql);
    const rows = (await tx.query(`SELECT id,source_id,task_id,config_hash,snapshot
      FROM public.kb_content_asset_hybrid_builds WHERE id=ANY($1::uuid[])`, [[legacy.id, custom.id]])).rows;
    const row = rows.find(item => item.id === legacy.id);
    expect(row).toEqual({ id: legacy.id, source_id: legacy.source, task_id: legacy.task, config_hash: hash,
      snapshot: { ...legacy.snapshot, mode: 'hybrid', target: { ...legacy.snapshot.target, collection: nextName } } });
    expect(rows.find(item => item.id === custom.id)?.snapshot).toEqual({ ...custom.snapshot, mode: 'hybrid' });
    expect(await indexIdentity()).toEqual({ ...previous, attname: 'content_asset_id' });
    const currentKeyword = { ...keyword, mode: 'keyword' };
    expect((await tx.query('SELECT config_hash,snapshot FROM public.kb_document_keyword_builds WHERE id=$1', [buildId])).rows[0])
      .toEqual({ config_hash: hash, snapshot: currentKeyword });
    expect((await tx.query('SELECT processing_snapshot FROM public.rag_ingestion_versions WHERE id=$1', [versionId])).rows[0].processing_snapshot)
      .toEqual({ ...processing, keyword: currentKeyword });
    const inputs = (await tx.query('SELECT id,body FROM public.task_inputs WHERE id=ANY($1::uuid[])', [[inputId, unrelatedInputId]])).rows;
    expect(JSON.parse(inputs.find(input => input.id === inputId)!.body)).toEqual({ ...JSON.parse(body), snapshot: { ...processing, keyword: currentKeyword } });
    expect(inputs.find(input => input.id === unrelatedInputId)?.body).toBe(body);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

it('stops before switching rows assigned to multiple legacy vector targets', async () => {
  const tx = await pool.connect();
  await tx.query('BEGIN');
  try {
    await insertBuild(tx, previousName);
    await insertBuild(tx, previousName, 'different_database');
    await expect(tx.query(migration.sql)).rejects.toThrow('CONTENT_ASSET_COLLECTION_TARGET_AMBIGUOUS');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});
