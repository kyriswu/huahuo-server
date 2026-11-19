import type pg from 'pg';
import type { AppConfig } from '../../config/config.js';
import { DOCUMENT_ASSET_MANIFEST_MAX_BYTES } from '../../config/document-extraction.js';
import { assertScope, transaction, type Scope } from '../identity/store.js';
import type { StorageService } from '../storage/service.js';
import { TextIngestionSourceType } from '../text-ingestion/types.js';
import type { UploadedResource } from '../../integrations/document-extraction.js';
import type { FileProcessingSnapshot } from './processing-profile.js';
import { ragImageKey, type RagImageRequest, type RagImageLink } from './query-service.js';

const imageUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

/** Hydrate only selected references, using owned DB records/parse receipts.
 * Signing is local. No original image is read, downloaded, or sent to a model. */
export class RagImageLinks {
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig, private readonly storage: StorageService) {}

  private async sign(receipt: Pick<UploadedResource, 'bucket' | 'object_key' | 'mime_type'>): Promise<RagImageLink | undefined> {
    const oss = this.config.storageAliyunOss;
    if (this.config.storageDriver !== 'aliyun-oss' || !oss || receipt.bucket !== oss.bucket || !receipt.mime_type.startsWith('image/') || !this.storage.storage.signUrl) return;
    const prefix = oss.keyPrefix?.replace(/^\/+|\/+$/gu, '');
    if (prefix && !receipt.object_key.startsWith(prefix + '/')) return;
    const key = prefix ? receipt.object_key.slice(prefix.length + 1) : receipt.object_key;
    if (!/^[a-z\d][a-z\d._/-]{0,1023}$/iu.test(key) || key.includes('..') || key.includes('//')) return;
    try { return { url: await this.storage.storage.signUrl(key, 900), expiresAt: new Date(Date.now() + 900_000).toISOString() }; }
    catch { return undefined; } // Optional previews cannot invalidate canonical evidence.
  }

  async resolve(scope: Scope, input: RagImageRequest[]): Promise<ReadonlyMap<string, RagImageLink>> {
    const requests = [...new Map(input.map(image => [ragImageKey(image), image])).values()];
    const result = new Map<string, RagImageLink>();
    const contentAssets = requests.filter(image => image.sourceType === 'content_asset');
    if (contentAssets.length) {
      const links = new Map((await this.storage.playbacks(scope, contentAssets.map(image => image.resourceId))).filter(link => link.mimeType.startsWith('image/')).map(link => [link.resourceId, link]));
      for (const image of contentAssets) { const link = links.get(image.resourceId); if (link) result.set(ragImageKey(image), { url: link.url, expiresAt: link.expiresAt }); }
    }
    const files = requests.filter(image => image.sourceType === 'file');
    if (files.length) {
      const rows = await transaction(this.pool, async tx => {
        await assertScope(tx, scope);
        return (await tx.query<{ id: string; version_id: string; workspace_id: string; content_hash: string; object_key: string; mime_type: string; metadata: UploadedResource }>(`SELECT a.id,a.version_id,v.workspace_id,v.content_hash,a.object_key,a.mime_type,a.metadata
          FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) x(version_id,workspace_id,resource_id)
          JOIN rag_ingestion_versions v ON v.id=x.version_id AND v.workspace_id=x.workspace_id AND v.user_id=$1 AND v.active AND v.deleted_at IS NULL AND v.status='SUCCEEDED'
          JOIN workspaces w ON w.id=v.workspace_id AND w.user_id=v.user_id AND w.state='ready'
          JOIN rag_document_assets a ON a.version_id=v.id AND a.id=x.resource_id AND a.upload_status='ready'`,
        [scope.userId, files.map(image => image.sourceId), files.map(image => image.workspaceId), files.map(image => image.resourceId)])).rows;
      });
      for (const row of rows) {
        const request = files.find(image => image.sourceId === row.version_id && image.resourceId === row.id && image.workspaceId === row.workspace_id && image.sourceRevision === row.content_hash);
        if (!request) continue;
        const link = await this.sign({ ...row.metadata, object_key: row.object_key, mime_type: row.mime_type });
        if (link) result.set(ragImageKey(request), link);
      }
    }
    const texts = requests.filter(image => image.sourceType === 'text');
    if (texts.length) {
      const rows = await transaction(this.pool, async tx => {
        await assertScope(tx, scope);
        return (await tx.query<{ id: string; source_type: TextIngestionSourceType; workspace_id: string; content_hash: string; artifact_uri: string | null; external_reference: string | null; body: string; image_resource_ids: string[] }>(`SELECT j.id,j.source_type,j.workspace_id,j.content_hash,j.artifact_uri,t.external_reference,i.body,
          ARRAY(SELECT r.resource_id FROM resource_refs r WHERE r.user_id=j.created_by AND r.workspace_id=j.workspace_id
            AND r.ref_kind='text-image' AND r.ref_id_external=j.id::text AND r.resource_id=ANY($3::uuid[])) AS image_resource_ids
          FROM text_ingestion_jobs j JOIN workspaces w ON w.id=j.workspace_id AND w.user_id=j.created_by AND w.state='ready'
          JOIN tasks t ON t.id=j.current_task_id AND t.user_id=j.created_by AND t.workspace_id=j.workspace_id
          JOIN task_inputs i ON i.id=t.input_id AND i.user_id=t.user_id AND i.workspace_id=t.workspace_id
          WHERE j.id=ANY($2::uuid[]) AND j.created_by=$1 AND j.ingest_status='success'`, [scope.userId, [...new Set(texts.map(image => image.sourceId))], [...new Set(texts.map(image => image.resourceId))]])).rows;
      });
      for (const row of rows) {
        const group = texts.filter(image => image.sourceId === row.id && image.workspaceId === row.workspace_id && image.sourceRevision === row.content_hash);
        if (!group.length) continue;
        if (row.source_type === TextIngestionSourceType.MANUAL_INPUT) {
          const pinned = new Set(row.image_resource_ids), selected = group.filter(image => pinned.has(image.resourceId));
          if (!selected.length) continue;
          const links = new Map((await this.storage.playbacks(scope, selected.map(image => image.resourceId), row.workspace_id))
            .filter(link => link.mimeType.startsWith('image/')).map(link => [link.resourceId, link]));
          for (const image of selected) {
            const link = links.get(image.resourceId);
            if (link) result.set(ragImageKey(image), { url: link.url, expiresAt: link.expiresAt });
          }
          continue;
        }
        if (row.source_type !== TextIngestionSourceType.FILE_UPLOAD || !this.storage.storage.signUrl || !row.external_reference?.startsWith('xberg-complete:')) continue;
        // The task freezes the mother resource + parse run. Never read a URI
        // supplied by Markdown, and never read the full original/parse JSON.
        try {
          const parser = (JSON.parse(row.body) as { snapshot?: FileProcessingSnapshot }).snapshot?.parser;
          if (!parser || !imageUuid(parser.sourceResourceId) || !imageUuid(parser.parseRunId)) continue;
          const state = JSON.parse(Buffer.from(row.external_reference.slice('xberg-complete:'.length), 'base64url').toString('utf8')) as { phase?: string; canonicalUri?: string; manifestUri?: string };
          const prefix = `extractions/${parser.sourceResourceId}/${parser.parseRunId}/`;
          if (state.phase !== 'complete' || state.canonicalUri !== row.artifact_uri || !state.manifestUri?.startsWith(prefix) || !/^[a-f\d]{64}\.assets\.json$/u.test(state.manifestUri.slice(prefix.length))) continue;
          const stream = await this.storage.storage.read(state.manifestUri), chunks: Buffer[] = []; let bytes = 0;
          try {
            for await (const chunk of stream) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
              if (bytes > DOCUMENT_ASSET_MANIFEST_MAX_BYTES) throw new Error('ASSET_MANIFEST_TOO_LARGE');
              chunks.push(buffer);
            }
          } finally { stream.destroy(); }
          const receipts: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(receipts)) continue;
          const byId = new Map<string, UploadedResource>();
          for (const value of receipts as Array<Partial<UploadedResource> | null>)
            if (typeof value?.resource_id === 'string' && value.uuid === value.resource_id && value.source_resource_id === parser.sourceResourceId && value.parse_run_id === parser.parseRunId)
              byId.set(value.resource_id, value as UploadedResource);
          for (const request of group) {
            const receipt = byId.get(request.resourceId);
            if (!receipt || typeof receipt.object_key !== 'string' || typeof receipt.mime_type !== 'string') continue;
            const link = await this.sign(receipt); if (link) result.set(ragImageKey(request), link);
          }
        } catch { /* The canonical evidence and UUIDs remain usable without a preview. */ }
      }
    }
    return result;
  }
}
