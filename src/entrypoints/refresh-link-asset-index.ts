import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig, type AppConfig } from '../config/config.js';
import { resolveTraceId } from '../lib/trace.js';
import { transaction } from '../modules/identity/store.js';
import { ContentAssetIndexService } from '../modules/ingestion/service.js';
import { uuidFor } from '../modules/kb/repository.js';
import type { TaskState } from '../modules/tasks/model.js';
import { poolFor } from '../plugins/dependencies.js';

const pageSize = 100;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
interface RefreshOptions { apply: boolean; after?: string }
interface Candidate { content_asset_id: string; user_id: string; build_id: string }

/** Each invocation inspects or enqueues one page on the explicitly configured database. */
export async function refreshLinkAssetIndexPage(pool: pg.Pool, config: AppConfig, { apply, after }: RefreshOptions) {
  return transaction(pool, async tx => {
    if (!apply) await tx.query('SET TRANSACTION READ ONLY');
    const candidates = (await tx.query<Candidate>(`SELECT asset.content_asset_id, asset.user_id, build.id AS build_id
      FROM content_assets asset
      JOIN users account ON account.id=asset.user_id AND account.status='active' AND account.deleted_at IS NULL
      JOIN content_asset_parts part ON part.content_asset_id=asset.content_asset_id AND part.part='raw'
      JOIN kb_content_asset_hybrid_builds build ON build.source_type='content_asset'
        AND build.source_id=asset.content_asset_id AND build.user_id=asset.user_id
        AND build.source_revision=part.part_revision_id::text AND build.published AND build.status='ready'
        AND build.snapshot->>'assetMetadata'='true'
      WHERE asset.asset_kind='link' AND asset.state='active' AND asset.processing_status='ready'
        AND ($1::uuid IS NULL OR asset.content_asset_id>$1::uuid)
      ORDER BY asset.content_asset_id LIMIT $2`, [after ?? null, pageSize + 1])).rows;
    const page = candidates.slice(0, pageSize);
    const tasks = page.map(candidate => ({
      candidate,
      // A new build supersedes the old one and is assigned its own operation ID.
      taskId: uuidFor(`link-asset-index-refresh:${candidate.build_id}`),
    }));
    let enqueued = 0;
    if (apply) {
      const service = new ContentAssetIndexService(pool, config);
      const traceId = resolveTraceId();
      for (const { candidate, taskId } of tasks) {
        if (await service.scheduleMetadataRefresh(tx, { userId: candidate.user_id, traceId }, candidate.content_asset_id, taskId)) enqueued++;
      }
    }
    const states = (await tx.query<{ state: TaskState }>(
      'SELECT state FROM tasks WHERE id=ANY($1::uuid[])', [tasks.map(task => task.taskId)],
    )).rows;
    const succeeded = states.filter(task => task.state === 'succeeded').length;
    const failed = states.filter(task => task.state === 'failed' || task.state === 'cancelled').length;
    return {
      mode: apply ? 'enqueue' : 'read-only',
      candidates: page.length,
      enqueued,
      succeeded,
      failed,
      pending: states.length - succeeded - failed,
      unscheduled: page.length - states.length,
      nextCursor: candidates.length > pageSize ? page.at(-1)!.content_asset_id : null,
    };
  });
}

function parseArgs(args: string[]): RefreshOptions {
  const apply = args[0] === '--apply';
  const remaining = apply ? args.slice(1) : args;
  if (!remaining.length) return { apply };
  const [option, after] = remaining;
  if (remaining.length !== 2 || option !== '--after' || !after || !uuid.test(after)) {
    throw new Error('LINK_ASSET_REFRESH_ARGUMENT_INVALID');
  }
  return { apply, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const config = loadConfig('migrate');
    const pool = poolFor(config);
    pool.on('error', () => undefined);
    try { console.log(JSON.stringify(await refreshLinkAssetIndexPage(pool, config, options))); }
    finally { await pool.end(); }
  } catch (error) {
    const code = error instanceof Error && /^(?:LINK_ASSET_REFRESH_|INVALID_CONFIG:)[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'LINK_ASSET_REFRESH_FAILED';
    console.error(JSON.stringify({ code }));
    process.exitCode = 1;
  }
}
