import { kbImages } from '../../lib/kb-images.js';
import { renderEditableKbImages } from '../../lib/kb-image-markdown.js';
import { assertScope, DomainError, transaction, type Scope } from '../identity/store.js';
import type { StorageService } from '../storage/service.js';
import { TextIngestionSourceType, type TextIngestionJob } from './types.js';

/** Response-only editable Markdown; persisted content and idempotent receipts stay canonical. */
export async function textImageViews(storage: StorageService, scope: Scope, jobs: readonly TextIngestionJob[]): Promise<TextIngestionJob[]> {
  const selected = jobs.filter(job => job.source_type === TextIngestionSourceType.MANUAL_INPUT && job.raw_content !== null)
    .map(job => ({ job, images: kbImages(job.raw_content!) })).filter(item => item.images.length);
  if (!selected.length) return [...jobs];
  const workspaces = await transaction(storage.pool, async tx => {
    await assertScope(tx, scope);
    return new Map((await tx.query<{ id: string; workspace_id: string }>(`SELECT j.id,j.workspace_id FROM text_ingestion_jobs j
      JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
      WHERE j.id=ANY($1::uuid[]) AND j.created_by=$2 AND j.source_type='MANUAL_INPUT'`, [selected.map(item => item.job.id), scope.userId])).rows.map(row => [row.id, row.workspace_id]));
  });
  if (workspaces.size !== selected.length) throw new DomainError(404, 'TEXT_INGESTION_NOT_FOUND');
  const rendered = new Map<string, string>();
  for (const workspaceId of new Set(workspaces.values())) {
    const group = selected.filter(item => workspaces.get(item.job.id) === workspaceId);
    const ids = [...new Set(group.flatMap(item => item.images.map(image => image.resourceId)))], links = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 1000)
      for (const link of await storage.playbacks(scope, ids.slice(offset, offset + 1000), workspaceId))
        if (link.mimeType.startsWith('image/')) links.set(link.resourceId, link.url);
    for (const { job, images } of group) {
      try { rendered.set(job.id, renderEditableKbImages(job.raw_content!, images, links)); }
      catch { throw new DomainError(503, 'TEXT_IMAGE_VIEW_UNAVAILABLE'); }
    }
  }
  return jobs.map(job => rendered.has(job.id) ? { ...job, raw_content: rendered.get(job.id)! } : job);
}
